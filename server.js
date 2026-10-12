const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static('./'));

const DB_FILE = path.join(__dirname, 'data.json');

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({licenses:[],users:[],version:{}}));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data,null,2));
}

app.post('/api/login',(req,res)=>{
  const {user,pwd}=req.body;
  if(user==='admin' && pwd==='admin123'){
    return res.json({ok:true})
  }
  res.json({ok:false,msg:'账号密码错误'})
})

app.post('/api/create-license',(req,res)=>{
  const {type}=req.body;
  const db=readDB();
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code='';
  for(let i=0;i<24;i++) code+=chars[Math.floor(Math.random()*chars.length)];
  const now=Date.now();
  let expire=null;
  if(type==='30d') expire=now+30*24*3600*1000;
  if(type==='90d') expire=now+90*24*3600*1000;
  if(type==='1y') expire=now+365*24*3600*1000;
  const lic={code,type,expire,bindMachine:null,createTime:now};
  db.licenses.push(lic);
  saveDB(db);
  res.json({ok:true,license:code})
})

app.get('/api/list-licenses',(req,res)=>{
  const db=readDB();
  res.json({ok:true,list:db.licenses})
})

app.post('/api/unbind',(req,res)=>{
  const {code}=req.body;
  const db=readDB();
  const item=db.licenses.find(x=>x.code===code);
  if(item){
    item.bindMachine=null;
    saveDB(db);
    return res.json({ok:true})
  }
  res.json({ok:false})
})

app.post('/api/verify',(req,res)=>{
  const {code,machine}=req.body;
  const db=readDB();
  const lic=db.licenses.find(x=>x.code===code);
  if(!lic) return res.json({ok:false,msg:'卡密不存在'});
  if(lic.expire && Date.now()>lic.expire) return res.json({ok:false,msg:'卡密已过期'});
  if(lic.bindMachine && lic.bindMachine!==machine) return res.json({ok:false,msg:'已绑定其他设备'});
  if(!lic.bindMachine) lic.bindMachine=machine;
  saveDB(db);
  res
