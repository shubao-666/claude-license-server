const {validate}=require('./license-store');
function createPool(connectionString){
 if(!connectionString)throw new Error('必须配置DATABASE_URL，禁止回退到临时文件存储');
 const url=new URL(connectionString);if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error('数据库连接格式无效');
 for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(key);
 const {Pool}=require('pg');const pool=new Pool({connectionString:url.toString(),ssl:{rejectUnauthorized:true},enableChannelBinding:true,
  max:2,min:0,idleTimeoutMillis:5000,connectionTimeoutMillis:15000,query_timeout:20000});
 pool.on('error',()=>console.error('数据库连接暂时不可用'));return pool;
}
function createPostgresStore({pool,connectionString,initialize=false}){
 pool=pool||createPool(connectionString);
 const ready=(async()=>{
  if(initialize){
   await pool.query('CREATE TABLE IF NOT EXISTS license_store_identity (id INTEGER PRIMARY KEY CHECK(id=1), initialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
   await pool.query('CREATE TABLE IF NOT EXISTS license_state (id INTEGER PRIMARY KEY CHECK(id=1), revision BIGINT NOT NULL DEFAULT 0, payload JSONB NOT NULL, previous_payload JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
   await pool.query('CREATE TABLE IF NOT EXISTS license_backups (day DATE PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
   const initial={keys:{},version:{latest:'2.0.0',url:'',note:'最新版本'}};
   await pool.query('INSERT INTO license_state(id,payload) SELECT 1,$1::jsonb WHERE NOT EXISTS(SELECT 1 FROM license_store_identity WHERE id=1) ON CONFLICT(id) DO NOTHING',[JSON.stringify(initial)]);
   await pool.query('INSERT INTO license_store_identity(id) VALUES(1) ON CONFLICT(id) DO NOTHING');
  }
  const {rows}=await pool.query('SELECT payload FROM license_state WHERE id=1');
  if(rows.length!==1)throw new Error('授权数据记录缺失，请恢复数据库备份，禁止自动清空');validate(rows[0].payload);
 })();
 async function snapshot(){await ready;const {rows}=await pool.query('SELECT revision,payload FROM license_state WHERE id=1');if(rows.length!==1)throw new Error('授权数据记录缺失');validate(rows[0].payload);return rows[0];}
 async function read(){return (await snapshot()).payload;}
 async function mutate(callback){
  for(let attempt=0;attempt<12;attempt++){
   const current=await snapshot(),data=JSON.parse(JSON.stringify(current.payload));const result=callback(data);
   if(result&&typeof result.then==='function')throw new Error('授权事务回调必须同步');
   if(result?.commit===false||JSON.stringify(data)===JSON.stringify(current.payload))return result;
   validate(data);
   // Compare-and-swap avoids overwriting concurrent generation/binding. Backup and live data commit in one SQL statement.
   const updated=await pool.query(`WITH changed AS (
     UPDATE license_state SET previous_payload=payload,payload=$2::jsonb,revision=revision+1,updated_at=NOW()
     WHERE id=1 AND revision=$1::bigint RETURNING revision,payload
    ), backed AS (
     INSERT INTO license_backups(day,payload) SELECT CURRENT_DATE,payload FROM changed
     ON CONFLICT(day) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()
    ) SELECT revision FROM changed`,[current.revision,JSON.stringify(data)]);
   if(updated.rows.length){return result;}
   await new Promise(resolve=>setTimeout(resolve,10+Math.floor(Math.random()*40)));
  }
  throw new Error('数据库更新冲突，请重试');
 }
 async function status(){await ready;const data=await read();const {rows}=await pool.query('SELECT COUNT(*)::integer AS count FROM license_backups');return {configured:true,backend:'PostgreSQL',recordCount:Object.keys(data.keys).length,dailyBackupCount:rows[0].count,backupError:null};}
 async function prune(){await ready;await pool.query("DELETE FROM license_backups WHERE day < CURRENT_DATE - 30");}
 const cleanup=setInterval(()=>prune().catch(()=>console.error('数据库备份维护暂时不可用')),24*3600000);cleanup.unref?.();
 return {ready,read,mutate,status,close:async()=>{clearInterval(cleanup);await pool.end();}};
}
module.exports={createPostgresStore,createPool};
