// 由 GitHub Actions 定時執行：從 TDX 抓停車資料，整理成網頁要用的精簡 JSON。
// 用法：node scripts/fetch-data.mjs <輸出資料夾>
// 環境變數：
//   TDX_CLIENT_ID / TDX_CLIENT_SECRET  TDX API 金鑰（沒設定就用免登入模式）
//   CITIES     逗號分隔的 TDX 縣市代碼，預設 Taipei
//   CACHE_DIR  基本資料（位置、名稱）的快取資料夾，一天才重新抓一次，預設 .cache
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const API = 'https://tdx.transportdata.tw/api/basic/v1/Parking';
const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TPE_LIVE = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json';
const CITIES = (process.env.CITIES || 'Taipei').split(',').map(s => s.trim()).filter(Boolean);
const CACHE_DIR = process.env.CACHE_DIR || '.cache';
const STATIC_TTL = 20 * 3600 * 1000;
const OUT = process.argv[2] || 'data';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getToken() {
  const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
  if (!id || !secret) {
    console.warn('沒有設定 TDX 金鑰，改用免登入模式（每日次數有限）');
    return null;
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error('取得 TDX token 失敗：HTTP ' + res.status + '（請檢查 Client ID / Secret）');
  return (await res.json()).access_token;
}

let calls = 0, loggedLimit = false;
async function getJSON(path, token) {
  const url = API + path + (path.includes('?') ? '&' : '?') + '%24format=JSON';
  for (let attempt = 1; ; attempt++) {
    await sleep(500); // 放慢速度，避免超過每秒呼叫上限
    calls++;
    const res = await fetch(url, { headers: token ? { authorization: 'Bearer ' + token } : {} });
    if (res.ok) return res.json();
    if (res.status === 404) { console.log('  無資料：' + path.split('?')[0]); return null; }
    if (res.status === 429 && attempt <= 5) {
      if (!loggedLimit) {
        loggedLimit = true;
        const h = [...res.headers].filter(([k]) => /rate|retry|limit/i.test(k)).map(([k, v]) => k + '=' + v).join(', ');
        console.log('  碰到呼叫次數限制' + (h ? '：' + h : ''));
      }
      // 照 TDX 指示的時間等待；沒有指示就等 65 秒（每分鐘限制重置）
      const wait = Number(res.headers.get('retry-after')) || 65;
      console.log(`  等待 ${wait} 秒後重試（第 ${attempt} 次）`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(path.split('?')[0] + ' → HTTP ' + res.status);
  }
}

// SpaceType 1 = 自小客車、2 = 機車；回傳 { car: [總數, 剩餘], motor: [總數, 剩餘] }
function spaces(rec) {
  const out = {};
  for (const a of rec?.Availabilities || []) {
    if (a.NumberOfSpaces > 0 && (a.SpaceType === 1 || a.SpaceType === 2)) {
      out[a.SpaceType === 1 ? 'car' : 'motor'] = [a.NumberOfSpaces, a.AvailableSpaces < 0 ? null : a.AvailableSpaces];
    }
  }
  if (!out.car && rec?.TotalSpaces > 0) out.car = [rec.TotalSpaces, rec.AvailableSpaces < 0 ? null : rec.AvailableSpaces];
  return out;
}

// 停車場位置、名稱一天才變一次，存在快取資料夾裡重複使用
async function getStatic(city, token) {
  const file = `${CACHE_DIR}/${city}-static.json`;
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    if (Date.now() - cached.t < STATIC_TTL) return cached;
  } catch {}
  const lots = await getJSON(`/OffStreet/CarPark/City/${city}?%24select=CarParkID,CarParkName,CarParkPosition,Address,FareDescription`, token);
  const segs = await getJSON(`/OnStreet/ParkingSegment/City/${city}?%24select=ParkingSegmentID,ParkingSegmentName,ParkingSegmentPosition,FareDescription,Description`, token);
  const data = { t: Date.now(), lots: lots?.CarParks || [], segs: segs?.ParkingSegments || [] };
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

// 台北市自己的停車場即時資料比 TDX 轉發的新，而且不佔 TDX 額度；代號和 TDX 的 CarParkID 相同
async function getTaipeiOwn() {
  try {
    const res = await fetch(TPE_LIVE);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = (await res.json()).data;
    // UPDATETIME 格式像 "Wed Oct 14 16:02:00 CST 2026"
    const m = d.UPDATETIME.match(/(\w{3}) (\d+) (\d\d:\d\d:\d\d) \w+ (\d{4})/);
    const time = m ? new Date(`${m[1]} ${m[2]} ${m[4]} ${m[3]} GMT+0800`).toISOString() : null;
    return { time, map: new Map(d.park.map(p => [p.id, p])) };
  } catch (e) {
    console.log('  台北市自有資料讀取失敗，改用 TDX：' + e.message);
    return null;
  }
}

// 台澎金馬範圍，用來排除座標填錯的資料
function inTaiwan(lat, lon) {
  return lat > 21.8 && lat < 26.5 && lon > 118 && lon < 122.1;
}

// TWD97 二度分帶（TM2，中央經線 121°）座標轉經緯度
function twd97ToWgs84(x, y) {
  const a = 6378137, b = 6356752.314245, k0 = 0.9999, lon0 = 121 * Math.PI / 180, dx = 250000;
  const e = Math.sqrt(1 - (b * b) / (a * a)), e2 = (e * a / b) ** 2;
  x -= dx;
  const mu = y / k0 / (a * (1 - e ** 2 / 4 - 3 * e ** 4 / 64 - 5 * e ** 6 / 256));
  const e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));
  const fp = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const C1 = e2 * Math.cos(fp) ** 2, T1 = Math.tan(fp) ** 2;
  const R1 = a * (1 - e * e) / Math.pow(1 - e * e * Math.sin(fp) ** 2, 1.5);
  const N1 = a / Math.sqrt(1 - e * e * Math.sin(fp) ** 2);
  const D = x / (N1 * k0);
  const lat = fp - (N1 * Math.tan(fp) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * e2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 3 * C1 * C1 - 252 * e2) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * e2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(fp);
  return [+(lat * 180 / Math.PI).toFixed(6), +(lon * 180 / Math.PI).toFixed(6)];
}

// 新北市的停車場不在 TDX 裡，改從新北市政府資料開放平臺抓（不需金鑰、不佔 TDX 額度）
async function getNtpcDataset(id) {
  const rows = [];
  for (let page = 0; page < 30; page++) {
    const res = await fetch(`https://data.ntpc.gov.tw/api/datasets/${id}/json?page=${page}&size=1000`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const batch = JSON.parse((await res.text()).replace(/^﻿/, ''));
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function getNewTaipeiLots() {
  try {
    const [lots, live] = [
      await getNtpcDataset('b1464ef0-9c7c-4a6f-abf7-6bdf32847e68'), // 新北市路外公共停車場資訊
      await getNtpcDataset('e09b35a5-a738-48cc-b0f5-570b67ad9c78'), // 新北市公有路外停車場即時賸餘車位數
    ];
    const avail = new Map(live.map(r => [r.ID, Number(r.AVAILABLECAR)]));
    const items = [];
    for (const p of lots) {
      const x = Number(p.TW97X), y = Number(p.TW97Y);
      if (!(x > 0 && y > 0)) continue;
      const [lat, lon] = twd97ToWgs84(x, y);
      if (!inTaiwan(lat, lon)) continue; // 原始資料座標填錯的略過
      const car = Number(p.TOTALCAR), motor = Number(p.TOTALMOTOR), a = avail.get(p.ID);
      items.push({ k: 'lot', id: 'NTPC' + p.ID, n: p.NAME, lat, lon, a: p.ADDRESS || '', f: (p.PAYEX || '').replace(/;$/, ''),
        ...(car > 0 ? { car: [car, a >= 0 ? a : null] } : {}),
        ...(motor > 0 ? { motor: [motor, null] } : {}) });
    }
    return { items, time: new Date().toISOString() };
  } catch (e) {
    console.log('  新北市開放資料讀取失敗：' + e.message);
    return null;
  }
}

function latest(...times) {
  const ts = times.filter(Boolean).map(t => new Date(t).getTime()).filter(n => !isNaN(n));
  return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
}

async function fetchCity(city, token) {
  const st = await getStatic(city, token);
  const lotLive = st.lots.length ? await getJSON(`/OffStreet/ParkingAvailability/City/${city}`, token) : null;
  const segLive = st.segs.length ? await getJSON(`/OnStreet/ParkingSegmentAvailability/City/${city}`, token) : null;
  const own = city === 'Taipei' ? await getTaipeiOwn() : null;

  const lotMap = new Map((lotLive?.ParkingAvailabilities || []).map(p => [p.CarParkID, p]));
  const segMap = new Map((segLive?.CurbParkingSegmentAvailabilities || []).map(s => [s.ParkingSegmentID, s]));
  const items = [];
  for (const p of st.lots) {
    const lat = p.CarParkPosition?.PositionLat, lon = p.CarParkPosition?.PositionLon;
    if (!inTaiwan(lat, lon)) continue;
    const sp = spaces(lotMap.get(p.CarParkID));
    const o = own?.map.get(p.CarParkID);
    if (o) {
      if (sp.car && o.availablecar >= 0) sp.car[1] = o.availablecar;
      if (sp.motor && o.availablemotor >= 0) sp.motor[1] = o.availablemotor;
    }
    items.push({ k: 'lot', id: p.CarParkID, n: p.CarParkName?.Zh_tw || p.CarParkID, lat, lon,
      a: p.Address || '', f: p.FareDescription || '', ...sp });
  }
  const ntpc = city === 'NewTaipei' ? await getNewTaipeiLots() : null;
  if (ntpc) {
    // 以新北市自己的停車場資料為準，取代 TDX 的（目前 TDX 沒有新北停車場）
    for (let i = items.length - 1; i >= 0; i--) if (items[i].k === 'lot') items.splice(i, 1);
    items.push(...ntpc.items);
  }
  for (const s of st.segs) {
    const lat = s.ParkingSegmentPosition?.PositionLat, lon = s.ParkingSegmentPosition?.PositionLon;
    if (!inTaiwan(lat, lon)) continue;
    items.push({ k: 'street', id: s.ParkingSegmentID, n: s.ParkingSegmentName?.Zh_tw || s.ParkingSegmentID, lat, lon,
      a: s.Description || '', f: s.FareDescription || '', ...spaces(segMap.get(s.ParkingSegmentID)) });
  }
  // 停車場和路邊各自記錄資料時間，網頁用來判斷資料是否過期
  const times = {
    lot: own?.time || ntpc?.time || lotLive?.SrcUpdateTime || null,
    street: segLive?.SrcUpdateTime || null,
  };
  return { city, updated: latest(times.lot, times.street), times, generated: new Date().toISOString(), items };
}

let token = null;
try {
  token = await getToken();
} catch (e) {
  console.log(`::warning::${e.message}，改用免登入模式`);
}
await mkdir(OUT, { recursive: true });
const summary = [];
for (const city of CITIES) {
  console.log('抓取 ' + city + ' …');
  let data;
  try {
    data = await fetchCity(city, token);
  } catch (e) {
    // 抓不到就跳過，其他縣市照常發布
    console.log(`::warning::${city} 資料抓取失敗：${e.message}`);
    continue;
  }
  await writeFile(`${OUT}/${city}.json`, JSON.stringify(data));
  const live = data.items.filter(i => i.car?.[1] != null || i.motor?.[1] != null).length;
  console.log(`  ${data.items.length} 個地點，其中 ${live} 個有即時空位；停車場資料時間 ${data.times.lot}，路邊資料時間 ${data.times.street}`);
  summary.push({ city, count: data.items.length, live, updated: data.updated, times: data.times });
}
await writeFile(`${OUT}/cities.json`, JSON.stringify(summary));
console.log(`完成，共呼叫 TDX ${calls} 次`);
