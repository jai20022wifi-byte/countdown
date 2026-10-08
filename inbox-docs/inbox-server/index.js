// INBOX ເອກະສານ — server for DigitalOcean App Platform.
// Same API as the old Google Apps Script (POST /api with { action, token, ... } → { ok, data | error }),
// so the web page works unchanged. Data: Postgres. Attachments: Spaces. Approved PDFs: Google Drive (via Apps Script relay).
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const webpush = require('web-push');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const ENV = process.env;
const SESSION_DAYS = 7;
const PERMS = ['createQuote','createExpense','viewAll','approveQuote','approveExpense','rpCheck','rpAccount','rpPresident','manageApproved','edit','print','manageUsers','projCreate','projEdit','projDelete','tfCreate','tfDone'];
const TZ = 'Asia/Vientiane';

// ---------- database ----------
const dbUrl = String(ENV.DATABASE_URL || '').replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
const db = new Pool({ connectionString: dbUrl, ssl: /localhost|127\.0\.0\.1/.test(dbUrl) ? false : { rejectUnauthorized: false }, max: 10 });
const q = (sql, p) => db.query(sql, p).then(r => r.rows);

async function migrate() {
  await q(`create table if not exists users (id text primary key, name text, pw_hash text, salt text, perms jsonb default '{}'::jsonb, sig text default '', pos text default '', sort bigserial)`);
  await q(`create table if not exists sessions (token text primary key, user_id text, expires bigint)`);
  await q(`create table if not exists docs (id text primary key, no text, type text, status text, created_by text, updated_at timestamptz default now(), data jsonb)`);
  await q(`create table if not exists customers (id text primary key, data jsonb, sort bigserial)`);
  await q(`create table if not exists kv (k text primary key, v jsonb)`);
  await q(`create table if not exists fx (id text primary key, no text, date text, by_id text, sort bigserial, data jsonb)`);
  await q(`create table if not exists fx_drafts (user_id text primary key, data jsonb)`);
  await q(`create table if not exists pdfs (doc_id text primary key, file_id text)`);
  await q(`create table if not exists push_subs (endpoint text primary key, user_id text, sub jsonb)`);
  let v = await kvGet('vapid'); if (!v) { v = webpush.generateVAPIDKeys(); await kvSet('vapid', v); }
  webpush.setVapidDetails('mailto:inboxsole@gmail.com', v.publicKey, v.privateKey); VAPID_PUB = v.publicKey;
  if (!(await kvGet('epoch'))) await kvSet('epoch', String(Date.now()));
  const [{ n }] = await q('select count(*)::int as n from users');
  if (n > 0) return;
  // First start: copy users, passwords, permissions, positions and signatures from Google; otherwise admin / 1234.
  try {
    const list = await relay('relayExportUsers', {});
    for (const u of list) await q('insert into users (id,name,pw_hash,salt,perms,sig,pos) values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing',
      [String(u.id), u.name, u.pwHash, u.salt, JSON.stringify(u.perms || {}), u.sig || '', u.pos || '']);
    console.log('imported users from Google:', list.length);
  } catch (e) {
    console.warn('user import failed, creating admin / 1234:', e.message);
    await addUser({ id: 'admin', name: 'ຜູ້ດູແລລະບົບ', pw: '1234', perms: Object.fromEntries(PERMS.map(p => [p, true])) });
  }
}
async function kvGet(k) { const r = await q('select v from kv where k=$1', [k]); return r[0] ? r[0].v : null; }
async function kvSet(k, v) { await q('insert into kv (k,v) values ($1,$2) on conflict (k) do update set v=excluded.v', [k, JSON.stringify(v)]); }

// ---------- files (Spaces) ----------
const region = ENV.SPACES_REGION || 'sgp1', bucket = ENV.SPACES_BUCKET || '';
const s3 = new S3Client({ region: 'us-east-1', endpoint: `https://${region}.digitaloceanspaces.com`, forcePathStyle: false,
  credentials: { accessKeyId: ENV.SPACES_KEY || '', secretAccessKey: ENV.SPACES_SECRET || '' } });
const publicUrl = key => ENV.SPACES_CDN ? `${ENV.SPACES_CDN.replace(/\/$/, '')}/${key}` : `https://${bucket}.${region}.digitaloceanspaces.com/${key}`;

// ---------- Google relay (approved PDFs stay in Drive) ----------
async function relay(action, body) {
  if (!ENV.GAS_URL || !ENV.RELAY_KEY) throw new Error('ຍັງບໍ່ໄດ້ຕັ້ງ GAS_URL / RELAY_KEY');
  const res = await fetch(ENV.GAS_URL, { method: 'POST', redirect: 'follow', body: JSON.stringify({ ...body, action, relayKey: ENV.RELAY_KEY }) });
  const t = await res.text(); let j;
  try { j = JSON.parse(t); } catch (e) { throw new Error('Google ຕອບກັບຜິດ (' + res.status + ')'); }
  if (!j.ok) throw new Error(j.error); return j.data;
}
const later = (label, fn) => { fn().catch(e => console.warn(label, e.message)); };

// ---------- helpers ----------
const hash = (pw, salt) => crypto.createHash('sha256').update(salt + '|' + pw, 'utf8').digest('base64');
const toUser = r => ({ id: r.id, name: r.name, pwHash: r.pw_hash, salt: r.salt, perms: r.perms || {}, sig: r.sig || '', pos: r.pos || '' });
const pub = u => ({ id: u.id, name: u.name, perms: u.perms, sig: u.sig || '', pos: u.pos || '' });
async function users() { return (await q('select * from users order by sort')).map(toUser); }
async function addUser(u) { const salt = crypto.randomUUID(); await q('insert into users (id,name,pw_hash,salt,perms,sig,pos) values ($1,$2,$3,$4,$5,$6,$7)', [u.id, u.name || u.id, hash(u.pw || '', salt), salt, JSON.stringify(u.perms || {}), u.sig || '', u.pos || '']); }
async function auth(r) {
  const s = (await q('select user_id, expires from sessions where token=$1', [String(r.token || '')]))[0];
  if (!s || Number(s.expires) < Date.now()) throw new Error('SESSION_EXPIRED');
  const u = (await q('select * from users where id=$1', [s.user_id]))[0];
  if (!u) throw new Error('SESSION_EXPIRED'); return toUser(u);
}
const parts = d => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(p => [p.type, p.value]));
const day = iso => { try { const p = parts(new Date(iso)); return `${p.year}-${p.month}-${p.day}`; } catch (e) { return ''; } };
const MULTI = t => t === 'income' || t === 'payment' || t === 'expense';
const sg = d => d.stage ?? (d.type === 'expense' ? 0 : 1);
function canApprove(u, d) { const p = u.perms || {};
  if (d.status === 'approved') return !!p.manageApproved;
  if (MULTI(d.type)) return !!p[d.status === 'pending' ? ({ 0: 'approveExpense', 1: 'rpAccount', 2: 'rpCheck', 3: 'rpPresident' }[sg(d)]) : 'rpPresident'];
  return d.type === 'quote' ? !!p.approveQuote : !!p.approveExpense; }
async function getDoc(id) { const r = await q('select data from docs where id=$1', [String(id)]); return r[0] ? r[0].data : null; }
async function putDoc(d) {
  await q(`insert into docs (id,no,type,status,created_by,updated_at,data) values ($1,$2,$3,$4,$5,now(),$6)
    on conflict (id) do update set no=excluded.no, type=excluded.type, status=excluded.status, created_by=excluded.created_by, updated_at=now(), data=excluded.data`,
    [String(d.id), d.no, d.type, d.status, d.createdBy, JSON.stringify(d)]);
}
async function visibleDocs(me, from) {
  const p = me.perms || {}, out = [];
  for (const r of await q('select type,status,created_by,data from docs')) {
    const own = r.created_by === me.id, st = r.status;
    if (!own && (st === 'draft' || !(p.viewAll || (r.type === 'quote' ? p.approveQuote : r.type === 'expense' ? (p.approveExpense || p.rpCheck || p.rpAccount || p.rpPresident) : (p.rpCheck || p.rpAccount || p.rpPresident))))) continue;
    if (!from || st === 'pending' || day(r.data.createdAt) >= from) out.push(r.data);
  }
  return out;
}
async function nextNo(type) {
  const p = parts(new Date()), pre = String(+p.month) + p.year.slice(2) + ({ quote: 'QT', expense: 'EX', income: 'RC', payment: 'PM' }[type] || 'EX');
  const n = (await q('select no from docs where no like $1', [pre + '%'])).reduce((m, x) => Math.max(m, +String(x.no).slice(pre.length) || 0), 0);
  return pre + String(n + 1).padStart(4, '0');
}
async function tmpNo() { const n = (await q(`select no from docs where no like 'TMP-%'`)).reduce((m, x) => Math.max(m, +String(x.no).slice(4) || 0), 0); return 'TMP-' + String(n + 1).padStart(4, '0'); }
async function names() { return Object.fromEntries((await users()).map(u => [u.id, u.name])); }
function dropPdf(id) { later('dropPdf', async () => { await relay('relayDropPdf', { id }); await q('delete from pdfs where doc_id=$1', [id]); }); }
function serverPdf(d) { later('serverPdf', async () => { const r = await relay('relayMakePdf', { doc: d, names: await names() }); if (r && r.fileId) await q('insert into pdfs values ($1,$2) on conflict (doc_id) do update set file_id=excluded.file_id', [String(d.id), r.fileId]); }); }
async function savePdfVia(r, root) {
  const { token, action, ...body } = r;
  const res = await relay('relaySavePdf', { ...body, root });
  if (r.docId && res && res.fileId) await q('insert into pdfs values ($1,$2) on conflict (doc_id) do update set file_id=excluded.file_id', [String(r.docId), res.fileId]);
  return res;
}
const lastAt = d => { const h = (d.history || []).filter(x => x.action === 'approved'); return h.length ? h[h.length - 1].at : (d.updatedAt || d.createdAt || new Date().toISOString()); };
async function fxList() { return (await q('select data from fx order by sort')).map(r => r.data); }

// ---------- Web Push ----------
let VAPID_PUB = '';
async function pushTo(ids, msg) {
  ids = [...new Set(ids.filter(Boolean).map(String))]; if (!ids.length || !VAPID_PUB) return;
  const subs = await q('select endpoint, user_id, sub from push_subs where user_id = any($1)', [ids]), badge = await badgeMap(ids);
  await Promise.all(subs.map(x => webpush.sendNotification(x.sub, JSON.stringify({ ...msg, badge: badge[x.user_id] || 0 }), { TTL: 86400 }).catch(async e => {
    if (e.statusCode === 404 || e.statusCode === 410) await q('delete from push_subs where endpoint=$1', [x.endpoint]); else console.warn('push', e.statusCode || e.message); })));
}
// Work waiting for each user — shown as the number on the app icon.
async function badgeMap(ids) {
  const us = (await users()).filter(u => ids.includes(u.id));
  const rows = (await q(`select data from docs where status in ('pending','returned') or (status='approved' and type in ('expense','payment') and coalesce(data->'tf'->>'status','new') <> 'done')`)).map(r => r.data);
  const m = {};
  for (const u of us) { let n = 0;
    for (const d of rows) {
      if (d.status === 'pending') { if (canApprove(u, d)) n++; }
      else if (d.status === 'returned') { if (d.createdBy === u.id) n++; }
      else { const st = (d.tf || {}).status; if ((!st || st === 'new') && u.pos === 'ບັນຊີ') n++; else if (st === 'created' && u.pos === 'ຜູ້ຈັດການ') n++; }
    }
    m[u.id] = n; }
  return m;
}
const TYPE_NAME = { quote: 'ໃບສະເໜີລາຄາ', expense: 'ໃບສະເໜີລາຍຈ່າຍ', income: 'ໃບລາຍຮັບ', payment: 'ໃບລາຍຈ່າຍ' };
const STAGE_NAME = { 0: 'ເລືອກບິນ', 1: 'ບັນຊີ', 2: 'ກວດສອບ', 3: 'ປະທານ' };
function docMsg(d, title) {
  const t = (d.type === 'quote' ? (d.fields || {}).customer : (d.fields || {}).purpose) || '';
  return { title, body: `${TYPE_NAME[d.type] || 'ເອກະສານ'} ${d.no || ''}${t ? ' · ' + t : ''}`, url: './?doc=' + encodeURIComponent(d.id), doc: String(d.id), tag: 'doc-' + d.id };
}
function notifyDoc(old, d, me) { later('push', async () => {
  const us = await users(), ids = f => us.filter(u => u.id !== me.id && f(u)).map(u => u.id);
  if (d.status === 'pending' && (!old || old.status !== 'pending' || sg(d) !== sg(old)))
    await pushTo(ids(u => canApprove(u, d)), docMsg(d, MULTI(d.type) ? 'ມີເອກະສານລໍຖ້າ' + STAGE_NAME[sg(d)] : 'ມີເອກະສານລໍຖ້າອະນຸມັດ'));
  if (old && old.status !== d.status && d.createdBy !== me.id) {
    const t = { returned: 'ເອກະສານຖືກສົ່ງກັບແກ້ໄຂ', rejected: 'ເອກະສານບໍ່ອະນຸມັດ', approved: 'ເອກະສານອະນຸມັດແລ້ວ' }[d.status];
    if (t) await pushTo([d.createdBy], docMsg(d, t));
  }
  if (d.status === 'approved' && (!old || old.status !== 'approved') && (d.type === 'expense' || d.type === 'payment'))
    await pushTo(ids(u => u.pos === 'ບັນຊີ' || (u.perms || {}).tfCreate), docMsg(d, 'ລໍຖ້າສ້າງໃບໂອນ'));
}); }

// ---------- API ----------
const API = {
  async login(r) {
    const u = (await q('select * from users where id=$1', [String(r.id || '').trim()]))[0];
    if (!u || hash(r.pw || '', u.salt) !== u.pw_hash) throw new Error('ໄອດີ ຫຼື ລະຫັດຜ່ານບໍ່ຖືກຕ້ອງ');
    const token = crypto.randomUUID(), expires = Date.now() + SESSION_DAYS * 864e5;
    await q('delete from sessions where expires < $1', [Date.now()]);
    await q('insert into sessions values ($1,$2,$3)', [token, u.id, expires]);
    return { token, expires, user: pub(toUser(u)) };
  },
  // Change password from the login page: old password required; signs out every device of that user.
  async changePassword(r) {
    const u = (await q('select * from users where id=$1', [String(r.id || '').trim()]))[0];
    if (!u || hash(r.oldPw || '', u.salt) !== u.pw_hash) throw new Error('ໄອດີ ຫຼື ລະຫັດຜ່ານເກົ່າບໍ່ຖືກຕ້ອງ');
    if (String(r.newPw || '').length < 4) throw new Error('ລະຫັດໃໝ່ຕ້ອງມີຢ່າງໜ້ອຍ 4 ຕົວ');
    const salt = crypto.randomUUID();
    await q('update users set pw_hash=$2, salt=$3 where id=$1', [u.id, hash(r.newPw, salt), salt]);
    await q('delete from sessions where user_id=$1', [u.id]);
    return true;
  },
  async logout(r) { await q('delete from sessions where token=$1', [String(r.token || '')]); return true; },
  async pushKey(r) { await auth(r); return { key: VAPID_PUB }; },
  async pushSubscribe(r) {
    const me = await auth(r), x = r.sub || {}; if (!x.endpoint) throw new Error('bad subscription');
    await q('insert into push_subs (endpoint,user_id,sub) values ($1,$2,$3) on conflict (endpoint) do update set user_id=excluded.user_id, sub=excluded.sub', [x.endpoint, me.id, JSON.stringify(x)]); return true;
  },
  async pushTest(r) {
    const me = await auth(r), n = (await q('select count(*)::int as n from push_subs where user_id=$1', [me.id]))[0].n;
    await pushTo([me.id], { title: 'ທົດສອບແຈ້ງເຕືອນ', body: 'ແຈ້ງເຕືອນຂອງ ' + me.name + ' ໃຊ້ໄດ້ແລ້ວ (' + n + ' ເຄື່ອງ)', url: './', tag: 'push-test' }); return n;
  },
  async pushUnsubscribe(r) { await q('delete from push_subs where endpoint=$1', [String(r.endpoint || '')]); return true; },
  async me(r) { return pub(await auth(r)); },
  async load(r) {
    const me = await auth(r);
    const [us, docs, projects, customers, epoch] = await Promise.all([users(), visibleDocs(me, r.from || ''), kvGet('projects'), q('select data from customers order by sort'), kvGet('epoch')]);
    return { users: us.map(pub), docs, projects: projects || [], customers: customers.map(x => x.data), epoch: epoch || '' };
  },
  async listDocs(r) { return visibleDocs(await auth(r), r.from || ''); },
  async listUsers(r) { await auth(r); return (await users()).map(pub); },
  async saveCustomer(r) {
    await auth(r); const c = r.c || {}; if (!c.id || !String(c.name || '').trim()) throw new Error('ຂໍ້ມູນລູກຄ້າບໍ່ຄົບ');
    await q('insert into customers (id,data) values ($1,$2) on conflict (id) do update set data=excluded.data', [String(c.id), JSON.stringify(c)]); return c;
  },
  async saveProjects(r) {
    const me = await auth(r), p = me.perms || {};
    if (!(p.projCreate || p.projEdit || p.projDelete || p.manageUsers)) throw new Error('ບໍ່ມີສິດແກ້ໂຄງການ');
    const l = [...new Set((r.list || []).map(x => String(x).trim()).filter(Boolean))]; await kvSet('projects', l); return l;
  },
  async upload(r) {
    await auth(r);
    if (!bucket) throw new Error('ຍັງບໍ່ໄດ້ຕັ້ງ SPACES_BUCKET');
    const [meta, b64] = String(r.dataUrl || '').split(',');
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    const ext = (String(r.name || '').match(/\.([a-z0-9]{1,5})$/i) || [])[1] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
    const p = parts(new Date()), key = `att/${p.year}-${p.month}/${crypto.randomUUID()}.${ext.toLowerCase()}`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(b64 || '', 'base64'), ContentType: mime, ACL: 'public-read', CacheControl: 'public, max-age=31536000, immutable' }));
    const url = publicUrl(key);
    return { name: r.name, fileId: key, url, thumbUrl: url, img: mime.indexOf('image/') === 0, s3: true };
  },
  async getFile(r) {
    await auth(r);
    if (!/^att\//.test(String(r.fileId || ''))) return relay('relayGetFile', { fileId: r.fileId });
    const o = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: r.fileId }));
    return { mime: o.ContentType || 'application/octet-stream', b64: Buffer.from(await o.Body.transformToByteArray()).toString('base64') };
  },
  async saveUser(r) {
    const me = await auth(r); if (!me.perms.manageUsers) throw new Error('ບໍ່ມີສິດຈັດການຜູ້ໃຊ້');
    const u = r.user || {}; u.perms = u.perms || {}; if (u.id === me.id) u.perms.manageUsers = true;
    const old = (await q('select id from users where id=$1', [String(u.id)]))[0];
    if (!old) { await addUser(u); return true; }
    await q('update users set name=$2, perms=$3, sig=$4, pos=$5 where id=$1', [u.id, u.name, JSON.stringify(u.perms), u.sig || '', u.pos || '']);
    if (u.pw) { const salt = crypto.randomUUID(); await q('update users set pw_hash=$2, salt=$3 where id=$1', [u.id, hash(u.pw, salt), salt]); }
    return true;
  },
  async deleteUser(r) {
    const me = await auth(r); if (!me.perms.manageUsers || r.id === me.id) throw new Error('ບໍ່ມີສິດ');
    await q('delete from users where id=$1', [String(r.id)]); await q('delete from sessions where user_id=$1', [String(r.id)]); return true;
  },

  // ---- documents ----
  async saveDoc(r) {
    const me = await auth(r), d = r.doc, old = await getDoc(d.id);
    if (!old && !(d.type === 'quote' ? me.perms.createQuote : me.perms.createExpense)) throw new Error('ບໍ່ມີສິດສ້າງເອກະສານ');
    const recall = old && old.status === 'pending' && d.status === 'returned' && old.createdBy === me.id;
    if (old && old.status !== d.status && ['approved', 'rejected', 'returned'].includes(d.status) && !canApprove(me, old) && !recall) throw new Error('ບໍ່ມີສິດອະນຸມັດ');
    if (old && old.status === 'approved' && !canApprove(me, old)) throw new Error('ເອກະສານອະນຸມັດແລ້ວ ແກ້ໄຂບໍ່ໄດ້');
    if (old && MULTI(old.type) && old.status === 'pending' && d.status === 'pending' && sg(d) > sg(old) && !canApprove(me, old)) throw new Error('ບໍ່ມີສິດຜ່ານຂັ້ນຕອນນີ້');
    if (!old) { d.createdBy = me.id; d.no = await tmpNo(); }
    if (old && d.status !== 'approved') d.no = old.no;
    const fresh = d.status === 'approved' && (!old || old.status !== 'approved');
    if (fresh) d.no = await nextNo(d.type);
    if (old && old.tf && !d.tf) d.tf = old.tf;
    await putDoc(d);
    notifyDoc(old, d, me);
    if (old && old.status === 'approved' && d.status !== 'approved') dropPdf(String(d.id));
    if (fresh) serverPdf(d);
    return d;
  },
  async deleteDoc(r) {
    const me = await auth(r), d = await getDoc(r.id);
    if (!d) return true;
    const ok = ['draft', 'returned'].includes(d.status) && (me.perms.edit || d.createdBy === me.id);
    if (!ok) throw new Error('ລຶບໄດ້ສະເພາະເອກະສານ ຮ່າງ ຫຼື ສົ່ງກັບແກ້ໄຂ');
    await q('delete from docs where id=$1', [String(d.id)]); dropPdf(String(d.id)); return true;
  },
  async setTransfer(r) {
    const me = await auth(r), p = me.perms || {}, d = await getDoc(r.id);
    if (!d) throw new Error('ບໍ່ພົບເອກະສານ');
    if (d.status !== 'approved') throw new Error('ເອກະສານຍັງບໍ່ອະນຸມັດ');
    const tf0 = d.tf || {}, st = r.tf && r.tf.status;
    if (st === 'created' && me.pos !== 'ບັນຊີ' && !p.tfCreate && !p.manageUsers) throw new Error('ບໍ່ມີສິດສ້າງໃບໂອນ');
    if (st === 'done' && me.pos !== 'ຜູ້ຈັດການ' && !p.tfDone && !p.manageUsers) throw new Error('ບໍ່ມີສິດໂອນເງິນ');
    if (st && st !== 'created' && st !== 'done' && st !== 'new') throw new Error('ສະຖານະບໍ່ຖືກ');
    if (!st && me.pos !== 'ບັນຊີ' && !p.tfCreate && !p.manageUsers) throw new Error('ບໍ່ມີສິດແນບຮູບ');
    const img = r.tf.img === undefined ? tf0.img : r.tf.img;
    if (st === 'created' && tf0.status !== 'created' && !img) throw new Error('ກະລຸນາແນບຮູບໃບໂອນກ່ອນ');
    if (!st || st === 'new' || tf0.status === st) d.tf = { ...tf0, img };
    else d.tf = st === 'created' ? { ...tf0, img, status: 'created', by: me.id, at: new Date().toISOString() } : { ...tf0, img, status: 'done', doneBy: me.id, doneAt: new Date().toISOString() };
    await putDoc(d);
    if (st && st !== 'new' && st !== tf0.status) later('push', async () => {
      const us = await users(), ids = f => us.filter(u => u.id !== me.id && f(u)).map(u => u.id);
      if (st === 'created') await pushTo(ids(u => u.pos === 'ຜູ້ຈັດການ' || (u.perms || {}).tfDone), docMsg(d, 'ລໍຖ້າໂອນເງິນ'));
      if (st === 'done') await pushTo(ids(u => u.pos === 'ບັນຊີ' || (u.perms || {}).tfCreate), docMsg(d, 'ໂອນເງິນສຳເລັດແລ້ວ'));
    });
    return d.tf;
  },
  async markDownloaded(r) {
    const me = await auth(r), d = await getDoc(r.id);
    if (me.pos !== 'ບັນຊີ') throw new Error('ບໍ່ມີສິດ: ສະເພາະຕຳແໜ່ງ ບັນຊີ');
    if (!d) throw new Error('ບໍ່ພົບເອກະສານ');
    if (!d.tf || d.tf.status !== 'done') throw new Error('ຍັງໂອນບໍ່ສຳເລັດ');
    d.tf = { ...d.tf, dl: { by: me.id, at: new Date().toISOString() } }; await putDoc(d); return d.tf;
  },
  async savePdf(r) { await auth(r); return savePdfVia(r, 'docs'); },
  async listNoPdf(r) {
    await auth(r);
    const rows = await q(`select d.data from docs d left join pdfs p on p.doc_id = d.id where d.status = 'approved' and p.doc_id is null`);
    return rows.map(({ data: d }) => ({ id: d.id, no: d.no, type: d.type, title: (d.type === 'quote' ? (d.fields || {}).customer : (d.fields || {}).purpose) || '', project: (d.fields || {}).project || '', at: lastAt(d) }));
  },
  async makePdf(r) {
    await auth(r); const d = await getDoc(r.id);
    if (!d) throw new Error('ບໍ່ພົບເອກະສານ'); if (d.status !== 'approved') throw new Error('ເອກະສານຍັງບໍ່ອະນຸມັດ');
    const res = await relay('relayMakePdf', { doc: d, names: await names() });
    if (res && res.fileId) await q('insert into pdfs values ($1,$2) on conflict (doc_id) do update set file_id=excluded.file_id', [String(d.id), res.fileId]);
    return res;
  },

  // ---- ສ້າງໃບແລກປ່ຽນເງີນ ----
  async loadFx(r) {
    const me = await auth(r), from = r.from || '';
    const drafts = (await q('select data from fx_drafts where user_id=$1', [me.id]))[0];
    return { fx: (await fxList()).filter(x => !from || String(x.date || day(x.createdAt)) >= from), fxDrafts: drafts ? drafts.data : [] };
  },
  async listFx(r) { await auth(r); return fxList(); },
  async saveFx(r) {
    const me = await auth(r), x = r.rec, old = (await q('select data from fx where id=$1', [String(x.id)]))[0];
    if (old && (old.data.status || 'approved') === 'approved' && x.status && x.status !== 'approved') dropPdf('fx-' + x.id);
    if (!old) {
      const n = (await q('select no from fx')).reduce((m, y) => Math.max(m, parseInt(String(y.no), 10) || 0), 0);
      x.no = String(n + 1).padStart(3, '0') + '/IN'; x.byId = me.id; x.by = me.name;
    }
    await q(`insert into fx (id,no,date,by_id,data) values ($1,$2,$3,$4,$5) on conflict (id) do update set no=excluded.no, date=excluded.date, by_id=excluded.by_id, data=excluded.data`,
      [String(x.id), x.no, x.date || '', x.byId || me.id, JSON.stringify(x)]);
    return x;
  },
  async deleteFx(r) { await auth(r); await q('delete from fx where id=$1', [String(r.id)]); dropPdf('fx-' + r.id); return true; },
  async saveFxDrafts(r) {
    const me = await auth(r), l = (r.drafts || []).slice(0, 10);
    await q('insert into fx_drafts values ($1,$2) on conflict (user_id) do update set data=excluded.data', [me.id, JSON.stringify(l)]); return true;
  },
  async savePdfFx(r) { await auth(r); return savePdfVia(r, 'fx'); }
};

// Writes run one at a time (like the old script lock) so numbers never collide.
const READS = new Set(['pushKey', 'pushUnsubscribe', 'me', 'load', 'listDocs', 'listUsers', 'getFile', 'listNoPdf', 'loadFx', 'listFx', 'login', 'logout', 'upload']);
let chain = Promise.resolve();
const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
app.use('/api', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', 'content-type'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
app.post('/api', express.text({ type: '*/*', limit: '40mb' }), async (req, res) => {
  let out;
  try {
    const r = JSON.parse(req.body || '{}'), fn = API[r.action];
    if (!fn) throw new Error('unknown action');
    out = { ok: true, data: await (READS.has(r.action) ? fn(r) : serial(() => fn(r))) };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg !== 'SESSION_EXPIRED') console.warn('api', msg);
    out = { ok: false, error: msg };
  }
  res.json(out);
});
app.get('/health', async (req, res) => {
  const c = { database: false, spaces: !!(bucket && ENV.SPACES_KEY && ENV.SPACES_SECRET), google: !!(ENV.GAS_URL && ENV.RELAY_KEY) };
  try { await q('select 1'); c.database = true; } catch (e) { c.databaseError = e.message; }
  res.json(c);
});
const pubDir = path.join(__dirname, 'public');
app.use(express.static(pubDir, { setHeaders: (res, f) => { if (/\.(html|js|json)$/.test(f)) res.set('Cache-Control', 'no-cache'); } }));
app.get('*', (req, res) => res.sendFile(path.join(pubDir, 'index.html')));

migrate().then(() => app.listen(ENV.PORT || 8080, () => console.log('INBOX server on', ENV.PORT || 8080)))
  .catch(e => { console.error('startup failed:', e); process.exit(1); });
