const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {validate,TYPES}=require('./license-store');
const {createPostgresStore}=require('./postgres-store');
const {isDeepStrictEqual}=require('util');
const limits={'1h':1,'7':1,'30':2,'90':3,'365':6,'永久':10};
function createLicenseServer({store,password,publicDirectory=path.join(__dirname,'public')}){
 if(!password)throw new Error('必须配置ADMIN_PASSWORD');
 const reply=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 const result=(response,status=200,commit=true)=>({response,status,commit});
 function authorized(req){const received=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+password);return received.length===expected.length&&crypto.timingSafeEqual(received,expected);}
 async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1048576){const e=new Error('请求体过大');e.status=413;throw e;}chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{const e=new Error('JSON格式错误');e.status=400;throw e;}}
 function key(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from({length:16},()=>chars[crypto.randomInt(chars.length)]).join('').match(/.{4}/g).join('-');}
 async function modify(res,fn){const outcome=await store.mutate(fn);reply(res,outcome.response,outcome.status);}
 return http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost'),route=url.pathname;
  if(route.startsWith('/api/admin/')&&!authorized(req)){reply(res,{success:false,reason:'未授权'},401);return;}
  if(route==='/api/verify'&&req.method==='POST'){
   const input=await body(req);
   if(typeof input.key!=='string'||typeof input.machineId!=='string'||!input.machineId.trim()||input.machineId.length>128){reply(res,{success:false,reason:'验证参数无效'},400);return;}
   await modify(res,data=>{
    const card=Object.hasOwn(data.keys,input.key)?data.keys[input.key]:null;
    if(!card)return result({success:false,reason:'卡密不存在'},200,false);
    if(card.expire!==null&&Date.now()>=card.expire)return result({success:false,reason:'卡密已过期'},200,false);
    const machines=card.machineList||(card.machineId?[card.machineId]:[]);
    if(!machines.includes(input.machineId)){
     if(machines.length>=limits[card.type])return result({success:false,reason:`已达绑定设备上限（${limits[card.type]}台），如需加设备请联系客服`},200,false);
     card.machineList=[...machines,input.machineId];if(!card.activateTime)card.activateTime=new Date().toISOString();
    }
    return result({success:true,type:card.type,expire:card.expire});
   });return;
  }
  if(route==='/api/version'&&req.method==='GET'){reply(res,{success:true,...(await store.read()).version});return;}
  if(route==='/api/admin/list'&&req.method==='GET'){reply(res,{success:true,keys:(await store.read()).keys});return;}
  if(route==='/api/admin/storage'&&req.method==='GET'){reply(res,{success:true,...await store.status()});return;}
  if(route==='/api/admin/export'&&req.method==='GET'){
   const data=await store.read();res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Disposition':'attachment; filename="license-backup.json"'});res.end(JSON.stringify(data,null,2));return;
  }
  if(route==='/api/admin/generate'&&req.method==='POST'){
   const input=await body(req),type=input.type||'永久';if(!TYPES.has(type)){reply(res,{success:false,reason:'不支持的卡密类型'},400);return;}
   await modify(res,data=>{let generated;do{generated=key();}while(Object.hasOwn(data.keys,generated));
    const expire=type==='永久'?null:Date.now()+(type==='1h'?3600000:Number(type)*86400000);
    data.keys[generated]={type,expire,note:String(input.note||'').slice(0,1000),machineId:null,createTime:new Date().toISOString()};
    return result({success:true,key:generated,data:data.keys[generated]});
   });return;
  }
  if(route==='/api/admin/restore'&&req.method==='POST'){
   const incoming=await body(req);try{validate(incoming);}catch(e){reply(res,{success:false,reason:e.message},400);return;}
   await modify(res,data=>{let added=0;for(const [id,card] of Object.entries(incoming.keys)){
    if(Object.hasOwn(data.keys,id)&&!isDeepStrictEqual(data.keys[id],card))return result({success:false,reason:'存在冲突卡密，已停止导入，原记录保持不变'},409,false);
    if(!Object.hasOwn(data.keys,id)){data.keys[id]=card;added++;}
   }return result({success:true,added,total:Object.keys(data.keys).length});});return;
  }
  if(route==='/api/admin/unbind'&&req.method==='POST'){
   const input=await body(req);await modify(res,data=>{const card=Object.hasOwn(data.keys,input.key)?data.keys[input.key]:null;
    if(!card)return result({success:false,reason:'卡密不存在'},200,false);card.machineList=[];card.machineId=null;return result({success:true});});return;
  }
  if(route==='/api/admin/version'&&req.method==='POST'){
   const input=await body(req);if(typeof input.latest!=='string'||!/^\d+\.\d+\.\d+$/.test(input.latest)){reply(res,{success:false,reason:'版本号格式无效'},400);return;}
   if(input.url&&(!String(input.url).startsWith('https://'))){reply(res,{success:false,reason:'下载地址需要HTTPS'},400);return;}
   await modify(res,data=>{data.version={latest:input.latest,url:input.url||'',note:String(input.note||'')};return result({success:true});});return;
  }
  if(route.startsWith('/api/')){reply(res,{success:false,reason:'接口不存在或请求方法错误'},404);return;}
  const target=path.resolve(publicDirectory,'.'+(route==='/'?'/index.html':decodeURIComponent(route)));
  if(!target.startsWith(publicDirectory+path.sep)){reply(res,{success:false},404);return;}
  const data=await fs.promises.readFile(target);res.writeHead(200,{'Content-Type':target.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream'});res.end(data);
 }catch(e){if(res.headersSent){res.destroy();return;}reply(res,{success:false,reason:e.status?e.message:'授权数据库暂时不可用，请稍后重试'},e.status||503);}});
}
async function start(){
 const store=createPostgresStore({connectionString:process.env.DATABASE_URL,initialize:process.env.INITIALIZE_LICENSE_STORE==='1'});
 try{await store.ready;const server=createLicenseServer({store,password:process.env.ADMIN_PASSWORD});server.listen(Number(process.env.PORT||3000),()=>console.log('License service ready: '+server.address().port));
  const close=()=>server.close(()=>store.close().finally(()=>process.exit()));process.once('SIGTERM',close);process.once('SIGINT',close);
 }catch(e){await store.close();throw e;}
}
if(require.main===module)start().catch(e=>{console.error('授权服务器启动失败，请检查数据库连接、初始化配置及管理员密码。错误代码：'+(e.code||'CONFIG'));process.exitCode=1;});
module.exports={createLicenseServer,start};
