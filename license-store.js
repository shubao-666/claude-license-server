const fs=require('fs'),path=require('path'),crypto=require('crypto');
const TYPES=new Set(['1h','7','30','90','365','永久']);
function validate(data){
 if(!data||typeof data!=='object'||!data.keys||Array.isArray(data.keys)||typeof data.keys!=='object')throw new Error('卡密数据结构无效');
 for(const [key,card] of Object.entries(data.keys)){
  if(!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(key)||!card||!TYPES.has(card.type))throw new Error('卡密记录格式无效');
  if(card.type==='永久'?card.expire!==null:(!Number.isFinite(card.expire)||card.expire<=0))throw new Error('卡密期限无效');
  if(card.machineList!==undefined&&(!Array.isArray(card.machineList)||card.machineList.some(v=>typeof v!=='string'||v.length>128)))throw new Error('机器绑定格式无效');
 }
 if(data.version!==undefined&&(!data.version||typeof data.version.latest!=='string'))throw new Error('版本信息无效');
 return data;
}
function createStore({directory,initialize=false}){
 if(!directory)throw new Error('未配置授权数据目录');
 directory=path.resolve(directory);fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,'data.json'),marker=path.join(directory,'.license-store-initialized');
 const previous=path.join(directory,'data.previous.json'),backups=path.join(directory,'backups');
 let backupError=null;
 function atomic(target,text){
  const temp=target+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';let fd;
  try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,target);
   if(process.platform!=='win32'){const parent=fs.openSync(path.dirname(target),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
  }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
 }
 function read(){return validate(JSON.parse(fs.readFileSync(file,'utf8')));}
 function snapshot(text){
  try{fs.mkdirSync(backups,{recursive:true});const day=new Date().toISOString().slice(0,10);atomic(path.join(backups,'data-'+day+'.json'),text);
   const names=fs.readdirSync(backups).filter(n=>/^data-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse();
   for(const name of names.slice(30))fs.unlinkSync(path.join(backups,name));backupError=null;
  }catch(e){backupError='备份写入失败：'+e.code;console.error(backupError);}
 }
 function write(data){validate(data);const old=fs.readFileSync(file,'utf8');validate(JSON.parse(old));const text=JSON.stringify(data,null,2);
  // A failed disk write never silently replaces the live store with an empty object.
  atomic(previous,old);atomic(file,text);snapshot(text);
 }
 if(!fs.existsSync(file)){
  if(fs.existsSync(marker)||!initialize)throw new Error('授权数据文件缺失。已停止启动，禁止自动清空或重建；请检查磁盘或恢复备份');
  atomic(file,JSON.stringify({keys:{},version:{latest:'2.0.0',url:'',note:'最新版本'}},null,2));
 }
 const initial=read();if(!fs.existsSync(marker))atomic(marker,'initialized\n');snapshot(JSON.stringify(initial,null,2));
 return {read,write,status:()=>({configured:true,recordCount:Object.keys(read().keys).length,backupError,
  dailyBackupCount:fs.existsSync(backups)?fs.readdirSync(backups).filter(n=>/^data-\d{4}-\d{2}-\d{2}\.json$/.test(n)).length:0})};
}
module.exports={createStore,validate,TYPES};
