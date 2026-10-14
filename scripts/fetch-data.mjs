// 由 GitHub Actions 定時執行：從 TDX 抓停車資料，整理成網頁要用的精簡 JSON。
// 用法：node scripts/fetch-data.mjs <輸出資料夾>
// 環境變數：TDX_CLIENT_ID / TDX_CLIENT_SECRET（沒設定就用免登入模式）、CITIES（逗號分隔，預設 Taipei）
import { mkdir, writeFile } from 'node:fs/promises';

const API = 'https://tdx.transportdata.tw/api/basic/v1/Parking';
const TOKEN_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const CITIES = (process.env.CITIES || 'Taipei').split(',').map(s => s.trim()).filter(Boolean);
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

async function getJSON(path, token) {
  const url = API + path + (path.includes('?') ? '&' : '?') + '%24format=JSON';
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: token ? { authorization: 'Bearer ' + token } : {} });
    if (res.ok) return res.json();
    if (res.status === 404) { console.warn('  無資料：' + path); return null; }
    if (res.status === 429 && attempt < 4) { await sleep(3000 * attempt); continue; }
    throw new Error(path + ' → HTTP ' + res.status);
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

async function fetchCity(city, token) {
  const [lots, lotLive, segs, segLive] = [
    await getJSON(`/OffStreet/CarPark/City/${city}?%24select=CarParkID,CarParkName,CarParkPosition,Address,FareDescription`, token),
    await getJSON(`/OffStreet/ParkingAvailability/City/${city}`, token),
    await getJSON(`/OnStreet/ParkingSegment/City/${city}?%24select=ParkingSegmentID,ParkingSegmentName,ParkingSegmentPosition,FareDescription,Description`, token),
    await getJSON(`/OnStreet/ParkingSegmentAvailability/City/${city}`, token),
  ];
  const lotMap = new Map((lotLive?.ParkingAvailabilities || []).map(p => [p.CarParkID, p]));
  const segMap = new Map((segLive?.CurbParkingSegmentAvailabilities || []).map(s => [s.ParkingSegmentID, s]));
  const items = [];
  for (const p of lots?.CarParks || []) {
    const lat = p.CarParkPosition?.PositionLat, lon = p.CarParkPosition?.PositionLon;
    if (!lat || !lon) continue;
    items.push({ k: 'lot', id: p.CarParkID, n: p.CarParkName?.Zh_tw || p.CarParkID, lat, lon,
      a: p.Address || '', f: p.FareDescription || '', ...spaces(lotMap.get(p.CarParkID)) });
  }
  for (const s of segs?.ParkingSegments || []) {
    const lat = s.ParkingSegmentPosition?.PositionLat, lon = s.ParkingSegmentPosition?.PositionLon;
    if (!lat || !lon) continue;
    items.push({ k: 'street', id: s.ParkingSegmentID, n: s.ParkingSegmentName?.Zh_tw || s.ParkingSegmentID, lat, lon,
      a: s.Description || '', f: s.FareDescription || '', ...spaces(segMap.get(s.ParkingSegmentID)) });
  }
  return {
    city,
    updated: lotLive?.SrcUpdateTime || segLive?.SrcUpdateTime || new Date().toISOString(),
    generated: new Date().toISOString(),
    items,
  };
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
    // 抓不到就跳過，網站照常發布，網頁會改成直接查 TDX
    console.log(`::warning::${city} 資料抓取失敗：${e.message}`);
    continue;
  }
  await writeFile(`${OUT}/${city}.json`, JSON.stringify(data));
  const live = data.items.filter(i => i.car?.[1] != null || i.motor?.[1] != null).length;
  console.log(`  ${data.items.length} 個地點，其中 ${live} 個有即時空位`);
  summary.push({ city, count: data.items.length, live, updated: data.updated });
}
await writeFile(`${OUT}/cities.json`, JSON.stringify(summary));
