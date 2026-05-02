const https = require('https');

const SUBWAY_COLORS = {
  1:'#0052A4', 2:'#00A650', 3:'#EF7C1C', 4:'#00A4E3',
  5:'#996CAC', 6:'#CD7C2F', 7:'#747F00', 8:'#E6186C',
  9:'#BDB092', 21:'#77C4A3', 22:'#4482C6', 100:'#D4003B',
  104:'#F5A200', 107:'#53B332', 109:'#BDB092'
};

function getColor(code) { return SUBWAY_COLORS[code] || '#888'; }
function cleanLine(name) { return name.replace(/^(수도권|서울|인천)\s*/, ''); }

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('응답 파싱 오류')); } });
    }).on('error', reject);
  });
}

async function geocode(name, key) {
  const url = `https://api.odsay.com/v1/api/searchStation?lang=0&stationName=${encodeURIComponent(name)}&apiKey=${encodeURIComponent(key)}`;
  const d = await get(url);
  if (!d.result?.station?.length) throw new Error(`"${name}" 역/정류장을 찾지 못했어요`);
  return d.result.station[0];
}

function parsePath(path) {
  const segments = [], tagMap = new Map();

  path.subPath.forEach((sub, i) => {
    const isEdge = i === 0 || i === path.subPath.length - 1;

    if (sub.trafficType === 3) {
      if (sub.sectionTime > 0) {
        segments.push({
          type: isEdge ? 'walk' : 'transfer',
          from: sub.startName, to: sub.endName,
          mins: sub.sectionTime, meters: Math.round(sub.distance || 0)
        });
      }
      return;
    }

    const lane = sub.lane[0];
    const isSubway = sub.trafficType === 1;
    const color = isSubway ? getColor(lane.subwayCode) : '#F59E0B';
    const lineName = isSubway ? cleanLine(lane.name) : lane.busNo + '번';
    const stations = sub.passStopList?.stations || [];
    const prevAlert = stations.length >= 2 ? stations[stations.length - 2].stationName : null;

    if (!tagMap.has(lineName)) tagMap.set(lineName, color);

    segments.push({
      type: isSubway ? 'subway' : 'bus',
      line: lineName, lineColor: color,
      from: sub.startName, to: sub.endName,
      stationCount: sub.stationCount || 0,
      mins: sub.sectionTime,
      prevAlertStation: prevAlert
    });
  });

  const info = path.info;
  const xfers = (info.subwayTransitCount || 0) + (info.busTransitCount || 0) - 1;
  const parts = [];
  if (info.subwayTransitCount > 0) parts.push('지하철');
  if (info.busTransitCount > 0) parts.push('버스');
  if (!parts.length) parts.push('도보');

  return {
    totalMins: info.totalTime,
    fare: info.payment,
    distance: info.trafficDistance,
    description: parts.join('+') + (xfers > 0 ? ` · 환승 ${xfers}회` : ' · 환승 없음'),
    tags: [...tagMap.entries()].map(([label, color]) => ({ label, color })),
    segments
  };
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { from, to } = event.queryStringParameters || {};
    if (!from || !to) throw new Error('출발지와 도착지를 입력해주세요');

    const key = process.env.ODSAY_API_KEY;
    if (!key) throw new Error('ODSAY_API_KEY 환경변수가 설정되지 않았어요');

    const [start, end] = await Promise.all([geocode(from, key), geocode(to, key)]);

    const url = `https://api.odsay.com/v1/api/searchPubTransPath?SX=${start.x}&SY=${start.y}&EX=${end.x}&EY=${end.y}&OPT=0&apiKey=${encodeURIComponent(key)}`;
    const data = await get(url);

    if (data.error) throw new Error(data.error.msg || '경로 탐색 오류');
    if (!data.result?.path?.length) throw new Error('경로를 찾지 못했어요. 역 이름을 다시 확인해보세요.');

    const routes = data.result.path.slice(0, 3).map(parsePath);

    return { statusCode: 200, headers, body: JSON.stringify({ routes, from: start.stationName, to: end.stationName }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
