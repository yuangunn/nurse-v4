// 어싸인 원칙 검사 — node scripts/test_assign_principles.mjs [배수=1]
//
// 배정 엔진(frontend/js/modules/assign-core.js)을 **모든 배치를 다 따져 본 정답**과 견준다. 무작위로 만든 하루·한 달을
// 원칙 ①②③④ 켜고 끄기 16가지 × 차지 자리 고정(101·122·82)/자유(102) × 방·병상·자리 이름만 아는 기록 × 주지 않을 방 ×
// 손으로 정한 자리 × 자리보다 사람이 많은 날로 돌린다. 정답은 엔진 코드를 쓰지 않고 이 파일 안에서 따로 센다.
// 씨앗이 고정이라 결과는 늘 같다 — 실패하면 씨앗과 그날 배치가 찍힌다. 자세한 설명은 docs/verification.md.
//
// 하루 검사 (한 시간대):
//   E1 모두 한 번씩 · 자리가 빈칸 없이 · 차지가 맞는 사람(표시 → 차지 가능 최선임 → 최선임, 주지 않을 방과 상관없이) · 차지 자리
//   E2 같은 입력이면 같은 결과
//   E3 꺼 둔 원칙에 해당하는 기록은 결과를 바꾸지 않는다 (원칙 4 가 꺼져 있으면 쉬고 온 기록은 아무 일도 안 한다)
//   E4 원칙 3·4 를 둘 다 켜면 원칙 3 만 켠 것과 같다
//   E5 [주지 않을 방 수, 원칙1·2·3 이어 보는 사람 수, 원칙1·2·3 겹친 병상] 이 정답과 같다 (사전식 — 앞이 먼저)
//   E6 원칙 4: 같은 헬퍼·같은 이어 보기로 튕김을 더 줄일 수 있는 배치가 없다
//   E7 원칙 4 는 누가 헬퍼인지 바꾸지 않는다
//   E8 헬퍼는 후임 — 이어 볼 것도 주지 않을 방도 없는데 선임이 헬퍼이고 후임이 앉아 있지 않다
//   E9 주지 않을 방은 차지를 바꾸지 않는다
//   E11 E5 가 같을 때 그다음 순서도 정답과 같다 — 헬퍼(선임이 헬퍼일수록 나쁘다) → 원칙 4 튕김 → 누가 잇는지(최근 → 선임)
//   E12 차지가 자리에 안 묶이면 누가 CRN 이든 자리는 같다 — CRN 이 차지가 아닐 때 앉았을 자리가 허락된 자리면 그 배치 그대로
//   그룹 인계 피하기 (opts.handoverGroups — 같은 그룹끼리 바로 앞 근무 D←전날 N · E←D · N←E 의 병상을 넘겨받지 않게):
//   E13 넘겨받는 병상이 있을 수 있는 날, [주지 않을 방, 넘겨받는 병상, 원칙…] 이 정답과 **같다** (나쁘지도 좋지도 않다)
//   E14 그룹은 누가 차지인지 바꾸지 않는다
//   E15 같은 그룹 사람이 앞 근무에서 본 병상을 아무도 넘겨받을 수 없으면 그룹이 없는 것과 결과가 똑같다
//   E16 엔진이 알리는 '피하지 못한 인계'(byDay.handover)가 엔진이 고른 배치로 정답이 센 목록과 같다 (준 사람·받은 사람·병상)
//   S0  (검사 준비) 앞 근무는 손으로 정한 자리 그대로 앉았다
// 여러 날 검사: 엔진 결과로 '전에 본 방'과 '앞 근무에서 병상마다 본 사람'을 따로 다시 쌓아 매일·시간대마다 E1·E5·E6·E11·E13·E16 을 보고,
//   E10 한 사람의 하루 근무를 바꾸면 그 앞날은 하나도 안 바뀐다
// 차지 검사: 차지는 정확히 한 명 · 깃발 하나 · 고정이면 '차지' 자리 · 자유면 허락된 자리 · 대체(자격 없음)는 자격자가 있으면 차지 아님
//   (절반은 그룹이 있다 — C4 가 그룹이 차지를 바꾸지 않는지도 본다)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { compute } = require('../frontend/js/modules/assign-core.js');

const SCALE = Math.max(0.05, +process.argv[2] || 1);
const LABELS = ['차지', 'A', 'B', 'C', 'D', 'E'];
const CHARGE = { DC: 1, EC: 1, NC: 1 };
const NAMES = ['가간호', '나간호', '다간호', '라간호', '마간호', '바간호', '사간호', '아간호', '자간호', '차간호'];
const RULE_KEYS = ['keepSameShift', 'keepAcrossShift', 'keepAfterOff', 'bounceAfterOff'];
const rulesOf = mask => Object.fromEntries(RULE_KEYS.map((k, i) => [k, !!(mask & (1 << i))]));

/* ─────────────────────────── 정답 (엔진과 따로) ─────────────────────────── */
function effRules(r) {
  const R = Object.assign({ keepSameShift: true, keepAcrossShift: true, keepAfterOff: true, bounceAfterOff: false }, r || {});
  if (R.keepAfterOff && R.bounceAfterOff) R.bounceAfterOff = false;   // ③ 이 이긴다
  return R;
}
// 등급: ① 어제 같은 근무 · ② 어제 다른 근무 · ③ 쉬고 옴(이틀 이상 전) — 꺼진 원칙은 등급 없음
function tier(inf, R, P) {
  if (!inf) return -1;
  if (R.keepSameShift && inf.idx === -1 && inf.period === P) return 0;
  if (R.keepAcrossShift && inf.idx === -1 && inf.period !== P) return 1;
  if (R.keepAfterOff && inf.idx < -1) return 2;
  return -1;
}
const offReturner = inf => !!(inf && inf.idx < -1);
function ovl(a, b, bedsOf) {
  if (!a || !b || !a.length || !b.length) return 0;
  let n = 0;
  for (const t of a) if (b.includes(t)) n += bedsOf ? Math.max(1, +bedsOf(t) || 1) : 1;
  return n;
}
const chargeOk = (n, P) => (n.chargeCapable && typeof n.chargeCapable === 'object') ? !!n.chargeCapable[P] : !!n.chargeCapable;
const bySen = (a, b) => a.seniority - b.seniority;
// 차지 사람: 표시(DC·EC·NC, 둘이면 선임) → 차지 가능 최선임 → 최선임. 주지 않을 방은 보지 않는다
function chargeOf(pb) {
  const m = pb.staff.filter(n => CHARGE[n.code]).sort(bySen)[0];
  if (m) return m.id;
  const pool = pb.staff.filter(n => chargeOk(n, pb.P));
  return (pool.length ? pool : pb.staff).slice().sort(bySen)[0].id;
}
// 이어 보기: 방을 아는 기록은 방이 겹칠 때만, 방을 모르면(또는 오늘 그 자리 방이 비면) 같은 자리 이름일 때만
function cont(pb, id, l) {
  const inf = pb.info[id];
  const t = tier(inf, pb.R, pb.P);
  if (t < 0) return null;
  if ((pb.avoid[id] || []).includes(l)) return null;     // 주지 않을 방이 이어 보기보다 먼저
  const known = pb.rooms && inf.rooms && inf.rooms.length && (pb.rooms[l] || []).length;
  if (known) {
    const o = Math.min(99, ovl(inf.rooms, pb.rooms[l], pb.bedsOf));
    return o > 0 ? { t, o } : null;
  }
  return inf.label === l ? { t, o: 0 } : null;
}
function bounced(pb, id, l) {
  if (!pb.R.bounceAfterOff) return false;
  const inf = pb.info[id];
  if (!offReturner(inf)) return false;
  const known = pb.rooms && inf.rooms && inf.rooms.length && (pb.rooms[l] || []).length;
  return known ? ovl(inf.rooms, pb.rooms[l]) > 0 : inf.label === l;
}
// 그룹 인계 — 같은 그룹 = **서로 다른** 두 사람의 그룹 목록에 같은 이름이 하나라도 있다
function sameGrp(pb, a, b) {
  if (a === b || !pb.groups) return false;
  const ga = pb.groups[a] || [], gb = pb.groups[b] || [];
  return ga.some(k => gb.includes(k));
}
// 이 사람이 이 자리에 앉으면 넘겨받는 병상 — 오늘 그 자리 방 중 같은 그룹 사람이 바로 앞 근무에서 본 방의 병상수 합
// (같은 그룹 사람 여럿이 본 방도 한 번만). pb.hold = {방: [앞 근무에서 그 방 자리에 앉았던 사람]} — 앞 근무가 없거나 방 정보가 없으면 null
function gOf(pb, id, l) {
  if (!pb.hold || !pb.rooms) return 0;
  const memo = pb._g || (pb._g = {}), k = id + '|' + l;
  if (k in memo) return memo[k];
  let w = 0;
  for (const t of pb.rooms[l] || [])
    if ((pb.hold[t] || []).some(h => sameGrp(pb, h, id))) w += pb.bedsOf ? Math.max(1, +pb.bedsOf(t) || 1) : 1;
  return (memo[k] = w);
}
// 넘겨받을 병상이 하나라도 생길 수 있는 날 (누가 어느 자리에 앉든)
const gActive = pb => !!pb.hold && pb.staff.some(n => pb.labels.some(l => gOf(pb, n.id, l) > 0));
// 이 배치에서 피하지 못한 같은 그룹 인계 — '준 사람>받은 사람:병상,…' 정렬 목록. 자리에 앉은 사람만 받는다(헬퍼는 병상이 없다)
function handoverList(pb, seat) {
  const out = [];
  if (!pb.hold || !pb.rooms) return out;
  for (const l in seat) {
    const to = seat[l], by = {};
    for (const t of pb.rooms[l] || []) for (const h of pb.hold[t] || []) if (sameGrp(pb, h, to)) (by[h] = by[h] || []).push(t);
    for (const h in by) out.push(`${h}>${to}:${by[h].slice().sort().join(',')}`);
  }
  return out.sort();
}
const engineHandover = d => (d.handover || []).map(x => `${x.from}>${x.to}:${x.rooms.slice().sort().join(',')}`).sort();
// 배치의 값 [-주지 않을 방, -넘겨받는 병상, C①, C②, C③, OV①, OV②, OV③] (클수록 좋다) + 튕김 수
function vec(pb, seat, chargeId) {
  let viol = 0, bo = 0, G = 0;
  const C = [0, 0, 0], OV = [0, 0, 0];
  for (const l in seat) {
    const id = seat[l];
    const pinnedCharge = pb.chargeSeats == null && id === chargeId;
    if (!(id in pb.ovr) && !pinnedCharge && (pb.avoid[id] || []).includes(l)) viol++;
    G += gOf(pb, id, l);
    const c = cont(pb, id, l);
    if (c) { C[c.t]++; OV[c.t] += c.o; }
    if (bounced(pb, id, l)) bo++;
  }
  return { v: [-viol, -G, C[0], C[1], C[2], OV[0], OV[1], OV[2]], viol, G, bo };
}
const VEC_NAMES = ['주지 않을 방', '넘겨받는 병상(같은 그룹)', '원칙1 사람 수', '원칙2 사람 수', '원칙3 사람 수', '원칙1 겹침', '원칙2 겹침', '원칙3 겹침'];
function cmp(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; return 0; }
// E5 다음 순서까지 — [...vec, -헬퍼, -튕김, 누가 잇는지]. 헬퍼는 선임부터 사전식(가장 선임이 헬퍼면 가장 나쁘다),
// 누가 잇는지는 이어 보는 사람마다 (최근에 봤을수록, 하루 단위로 100일까지) × 100 + 선임. 엔진의 '옮긴 사람 수'(위 단계 배치를
// 덜 흔드는 쪽)는 엔진 안쪽 순서라 여기서 보지 않는다 — 그 아래는 E2(같은 입력이면 같은 결과)가 지킨다
function fullKey(pb, seat, extra, chargeId) {
  const e = vec(pb, seat, chargeId);
  const rank = {}; pb.staff.slice().sort(bySen).forEach((n, i) => { rank[n.id] = i; });
  let hk = 0; for (const id of extra) hk += 2 ** (pb.staff.length - 1 - rank[id]);
  let tie = 0;
  for (const l in seat) {
    const id = seat[l];
    if (!cont(pb, id, l)) continue;
    const ago = Math.max(1, Math.min(101, -pb.info[id].idx));
    tie += (101 - ago) * 100 + Math.max(0, 99 - pb.staff.find(n => n.id === id).seniority);
  }
  return e.v.concat([-hk, -e.bo, tie]);
}
// 가능한 배치를 전부: 손으로 정한 자리 고정, 차지는 '차지'(고정) 또는 허락된 자리 중 하나(자유), 자리마다 한 사람, 나머지는 헬퍼
function enumerate(pb, chargeId, cb) {
  const seat = {}, used = {};
  for (const id in pb.ovr) if (pb.labels.includes(pb.ovr[id]) && !seat[pb.ovr[id]]) { seat[pb.ovr[id]] = id; used[id] = 1; }
  const pinned = !pb.chargeSeats;
  if (pinned && !used[chargeId] && !seat['차지']) { seat['차지'] = chargeId; used[chargeId] = 1; }
  const free = pb.labels.filter(l => !seat[l]);
  const people = pb.staff.map(n => n.id).filter(id => !used[id]);
  const chargeFree = !pinned && !used[chargeId];
  const okC = chargeFree ? pb.chargeSeats.filter(l => free.includes(l)) : [];
  const rec = k => {
    if (k === free.length) {
      const seated = Object.values(seat);
      if (chargeFree && okC.length && !seated.includes(chargeId)) return;
      cb(Object.assign({}, seat), people.filter(id => !seated.includes(id)));
      return;
    }
    const l = free[k];
    for (const id of people) {
      if (used[id]) continue;
      if (chargeFree && okC.length && id === chargeId && !okC.includes(l)) continue;
      used[id] = 1; seat[l] = id; rec(k + 1); delete seat[l]; used[id] = 0;
    }
  };
  rec(0);
}
function best(pb, chargeId) {
  let b = null, bs = null, f = null, fs = null;
  enumerate(pb, chargeId, (seat, extra) => {
    const e = vec(pb, seat, chargeId); if (!b || cmp(e.v, b.v) > 0) { b = e; bs = seat; }
    const k = fullKey(pb, seat, extra, chargeId); if (!f || cmp(k, f) > 0) { f = k; fs = Object.assign({}, seat); }
  });
  return { best: b, seat: bs, full: f, fseat: fs };
}
const FULL_NAMES = VEC_NAMES.concat(['헬퍼(선임이 헬퍼)', '원칙4 튕김', '누가 잇는지(최근 → 선임)']);
// E5 를 통과한 날만 — E5 가 틀리면 그 실패가 먼저다
function checkFull(pb, core, bf, tag) {
  if (!bf.full || (bf.best && cmp(bf.best.v, vec(pb, core.labels, core.charge).v) > 0)) return;
  count('E11');
  const ck = fullKey(pb, core.labels, core.extra, core.charge);
  if (cmp(bf.full, ck) > 0) {
    let k = 0; while (bf.full[k] === ck[k]) k++;
    fail('E11', FULL_NAMES[k] + ' 이 정답보다 나쁘다', tag + ` 엔진값 ${ck} 정답값 ${bf.full} 정답 ${JSON.stringify(bf.fseat)}`);
  }
}

/* ─────────────────────────── 무작위 문제 ─────────────────────────── */
// 씨앗을 섞고 처음 몇 개를 버린다 — 1, 2, 3… 처럼 이어지는 작은 씨앗을 그대로 xorshift 에 넣으면 첫 값이 씨앗에 거의 비례해,
// 첫 값으로 정하는 인원이 작은 배수에서 2~4명만 나왔다(헬퍼가 있는 날이 0). (2026-10-01 교차 검토)
function rng(seed) {
  let s = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0; s ^= s >>> 13; s = Math.imul(s, 0xc2b2ae35) >>> 0; s ^= s >>> 16; s = s >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < 8; i++) next();
  return next;
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const shuffle = (r, a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ROOMS = Array.from({ length: 14 }, (_, i) => String(1001 + i));
function partition(r, k, contiguous) {
  const rooms = contiguous ? ROOMS.slice() : shuffle(r, ROOMS);
  const cuts = shuffle(r, Array.from({ length: 13 }, (_, i) => i + 1)).slice(0, k - 1).sort((a, b) => a - b);
  const out = []; let p = 0;
  for (const c of cuts.concat([14])) { out.push(rooms.slice(p, c)); p = c; }
  return out;
}
// 그룹 인계 층 — 하루 문제에 그룹과 '앞 근무'(D 는 전날 N, E 는 같은 날 D, N 은 같은 날 E)를 얹는다.
// 앞 근무 사람은 손으로 정한 자리(overrides)에 못 박아 누가 어느 병상을 봤는지를 검사 쪽이 안다(pb.hold).
// 섞는 것: 앞 근무 없음 · 바로 앞이 아닌 근무만 있음(D 앞에 전날 E, E 앞에 전날 N, N 앞에 같은 날 D) · 너무 오래된 앞 근무(D 앞에 그저께 N,
// E 앞에 전날 D, N 앞에 전날 E) · 앞 근무 헬퍼(자리보다 사람이 많다) · 두 자리가 함께 보는 방 · 아무도 안 보는 방 · 그룹 없는 사람 ·
// 그룹 둘 · 앞 근무와 겹치지 않는 그룹 · 그룹 목록이 다 빈 날 · 오늘 근무하는 사람이 앞 근무(전날 N 등)에도 있는 날(같은 사람은 같은 그룹이 아니다)
const PREV = { D: 'N', E: 'D', N: 'E' };
const GKEYS = ['신규', '1년차', '교육'];
const PRE_NAMES = ['카간호', '타간호', '파간호', '하간호', '거간호', '너간호', '더간호'];
const NOISE_NAMES = ['러간호', '머간호', '버간호', '서간호'];
function grpOf(r, pool) {
  const u = r();
  if (u < 0.4) return null;
  if (u < 0.85) return [pick(r, pool)];
  return shuffle(r, pool).slice(0, 2);
}
// 앞 근무 방 구성 — 가끔 두 자리가 같은 방을 함께 보고, 아무도 안 보는 방·방 구성이 빈 자리도
function preRooms(r, k) {
  const parts = partition(r, k, r() < 0.6);
  if (k > 1 && r() < 0.3) { const i = Math.floor(r() * k), j = (i + 1 + Math.floor(r() * (k - 1))) % k; if (parts[i].length) parts[j].push(pick(r, parts[i])); }
  if (r() < 0.15) { const i = Math.floor(r() * k); if (parts[i].length > 1) parts[i].splice(Math.floor(r() * parts[i].length), 1); }
  if (r() < 0.1) parts[Math.floor(r() * k)] = [];
  return parts;
}
function holdersOf(sh) {
  const h = {};
  for (const id in sh.pins) for (const t of sh.rooms[sh.pins[id]] || []) (h[t] = h[t] || []).push(id);
  return h;
}
function addLayer(pb, rg) {
  pb.layer = null; pb.groups = null; pb.hold = null;
  if (rg() < 0.35) return;
  const P = pb.P;
  const kind = pick(rg, ['proper', 'proper', 'proper', 'proper', 'proper', 'none', 'stale', 'wrong']);
  const sp = kind === 'proper' ? { P: PREV[P], back: P === 'D' ? 1 : 0 }
    : kind === 'stale' ? { P: PREV[P], back: P === 'D' ? 2 : 1 }
      : kind === 'wrong' ? (P === 'D' ? { P: 'E', back: 1 } : P === 'E' ? { P: 'N', back: 1 } : { P: 'D', back: 0 })
        : null;
  const shifts = [];
  if (sp) {
    const n = 1 + Math.floor(rg() * 7), seats = pick(rg, [3, 4, 5, 6]);
    const people = [];
    // 오늘 근무하는 사람이 앞 근무에도 (다른 날에만 — 하루에 근무는 하나)
    if (sp.back > 0 && rg() < 0.35)
      for (const s of shuffle(rg, pb.staff).slice(0, 1 + Math.floor(rg() * 2))) people.push({ id: s.id, seniority: s.seniority, chargeCapable: s.chargeCapable, dup: true });
    for (let i = 0; people.length < n; i++) people.push({ id: PRE_NAMES[i], seniority: 20 + i, chargeCapable: rg() < 0.5 });
    const k = Math.min(people.length, seats), labs = LABELS.slice(0, k);
    const order = shuffle(rg, people), pins = {};
    labs.forEach((l, i) => { pins[order[i].id] = l; });
    const parts = preRooms(rg, k);
    const rooms = pb.rooms ? Object.fromEntries(labs.map((l, i) => [l, parts[i]])) : null;
    shifts.push(Object.assign({}, sp, { people, seats, pins, rooms }));
    // 앞 근무 자리에 앉은 '오늘 근무자'의 기록은 그 자리가 된다 (엔진이 그 근무를 배정하며 덮어쓴다)
    for (const p of people) if (p.dup && pins[p.id])
      pb.info[p.id] = { idx: -sp.back, period: sp.P, label: pins[p.id], rooms: rooms ? rooms[pins[p.id]] : null, fromPre: true };
  }
  // 앞 근무보다 더 앞의 근무 (자리를 못 박지 않는다 — 넘겨주는 사람이 아니다)
  if (kind === 'proper' && rg() < 0.3) {
    const np = P === 'D' ? { P: pick(rg, ['D', 'E']), back: 1 } : P === 'E' ? { P: 'N', back: 1 } : { P: 'D', back: 0 };
    const n = 1 + Math.floor(rg() * 4), seats = pick(rg, [3, 4, 5]);
    const people = NOISE_NAMES.slice(0, n).map((id, i) => ({ id, seniority: 30 + i, chargeCapable: rg() < 0.5 }));
    const k = Math.min(n, seats), parts = partition(rg, k, rg() < 0.5);
    const rooms = pb.rooms ? Object.fromEntries(LABELS.slice(0, k).map((l, i) => [l, parts[i]])) : null;
    shifts.push(Object.assign({}, np, { people, seats, pins: null, rooms }));
  }
  const disjoint = rg() < 0.2;                               // 오늘 근무자와 앞 근무의 그룹이 겹치지 않는 날
  const groups = {};
  for (const s of pb.staff) { const g = grpOf(rg, disjoint ? ['신규', '교육'] : GKEYS); if (g) groups[s.id] = g; }
  for (const sh of shifts) for (const p of sh.people) if (!p.dup) { const g = grpOf(rg, disjoint ? ['1년차'] : GKEYS); if (g) groups[p.id] = g; }
  if (rg() < 0.05) for (const id in groups) groups[id] = [];
  const pi = Math.max(0, ...shifts.map(s => s.back));
  pb.layer = { kind, pi, dks: Array.from({ length: pi + 1 }, (_, i) => 'd' + i), shifts };
  pb.groups = groups;
  pb.hold = kind === 'proper' && pb.rooms ? holdersOf(shifts[0]) : null;
}

// 하루 한 시간대(D·E·N). opt.avoid: 주지 않을 방을 꼭 넣을지
function genProblem(seed, opt) {
  const r = rng(seed);
  const rg = rng(seed * 7 + 3);                              // 시간대·그룹 층은 따로 — 위 문제의 난수를 흔들지 않는다
  const P = pick(rg, ['D', 'E', 'N']), others = ['D', 'E', 'N'].filter(x => x !== P);
  const n = 2 + Math.floor(r() * 6);                       // 2~7명
  const seats = pick(r, [4, 5, 5, 6]);
  const staff = [];
  for (let i = 0; i < n; i++) staff.push({ id: NAMES[i], seniority: i, chargeCapable: r() < (i < 3 ? 0.85 : 0.35), code: P });
  if (r() < 0.25) pick(r, staff).code = P + 'C';
  if (r() < 0.05) pick(r, staff).code = P + 'C';           // 표시가 둘인 날
  const labels = LABELS.slice(0, Math.min(n, seats));
  let rooms = null;
  if (r() < 0.75) {
    const parts = partition(r, labels.length, r() < 0.6);
    rooms = {};
    labels.forEach((l, i) => { rooms[l] = r() < 0.15 ? [] : parts[i]; });   // 방 구성이 빈 자리도 (다듬기를 꼭 돌려야 하는 날)
  }
  const bedMap = {}; ROOMS.forEach(x => { bedMap[x] = 1 + Math.floor(r() * 4); });
  const bedsOf = r() < 0.5 ? (t => bedMap[t] || 1) : null;
  const ySch = {}; for (const p of ['D', 'E', 'N']) ySch[p] = partition(r, 5, r() < 0.6);
  const oldSch = partition(r, 5, r() < 0.5);
  const yUsed = { D: [], E: [], N: [] };
  const info = {};
  for (const s of staff) {
    const u = r();
    if (u < 0.25) continue;                                 // 기록 없음
    let inf;
    if (u < 0.6) inf = { idx: -1, period: P };
    else if (u < 0.75) inf = { idx: -1, period: pick(r, others) };
    else inf = { idx: -pick(r, [2, 2, 3, 5, 9]), period: pick(r, ['D', 'D', 'E', 'N']) };
    let gi;
    if (inf.idx === -1) {
      const free = [0, 1, 2, 3, 4].filter(g => !yUsed[inf.period].includes(g));
      if (!free.length) continue;
      gi = pick(r, free); yUsed[inf.period].push(gi);
      inf.rooms = ySch[inf.period][gi];
    } else { gi = Math.floor(r() * 5); inf.rooms = oldSch[gi]; }
    inf.label = LABELS[gi];
    if (r() < 0.2) inf.rooms = null;                        // 자리 이름만 아는 기록 (지난 어싸인 직접 입력)
    info[s.id] = inf;
  }
  // 차지 자리가 자유인 서식은 허락된 자리도 여러 모양으로 — 102 앞 세 자리 · 차지 자리를 뺀 둘 · 한 자리(82 N 처럼).
  // 손으로 정한 자리는 가끔 둘이고, 자유 서식이면 첫 자리('차지')에도 앉힌다 — 허락된 자리가 다 손으로 차는 날을 만들려고 (2026-10-01 교차 검토)
  const mode = pick(r, ['pinned', 'pinned', 'float', 'floatPart']);
  const chargeSeats = mode === 'pinned' ? null : mode === 'float' ? LABELS.slice() : pick(r, [['차지', 'A', 'B'], ['차지', 'A', 'B'], ['A', 'B'], [pick(r, labels)]]);
  const ovr = {};
  const nOv = r() < 0.15 ? (r() < 0.3 ? 2 : 1) : 0;
  for (let i = 0; i < nOv; i++) {
    const who = pick(r, staff.filter(s => s.code !== 'DC' && !(s.id in ovr)).slice(1));
    const lab = pick(r, (mode === 'pinned' ? labels.slice(1) : labels).filter(l => !Object.values(ovr).includes(l)));
    if (who && lab) ovr[who.id] = lab;
  }
  const avoid = {};
  if (opt.avoid || r() < 0.2) {
    const k = 1 + Math.floor(r() * 2);
    for (let i = 0; i < k; i++) avoid[pick(r, staff).id] = shuffle(r, labels).slice(0, 1 + Math.floor(r() * 2));
  }
  const mask = Math.floor(r() * 16);
  const pb = { P, staff, labels, seats, rooms, bedsOf, info, ovr, avoid, chargeSeats, mask, mode, R: effRules(rulesOf(mask)) };
  addLayer(pb, rg);
  return pb;
}
// 엔진에 넣기 — 문제 날은 dks[pi], 기록(seed)의 idx 는 dateKeys[0] 기준이라 pi 만큼 민다. 앞 근무 자리에 앉은 오늘 근무자의 기록은
// 엔진이 앞 근무를 배정하며 만드므로 seed 로 주지 않는다. o.noGroups: 그룹만 빼고 똑같이
function runCore(pb, o) {
  o = o || {};
  const info = o.info || pb.info, avoid = o.avoid || pb.avoid;
  const L = pb.layer, pi = L ? L.pi : 0, dks = L ? L.dks : ['x'], X = dks[pi];
  const seed = {};
  for (const id in info) if (!info[id].fromPre) seed[id] = { label: info[id].label, period: info[id].period, idx: info[id].idx + pi, rooms: info[id].rooms };
  const sched = {}, ov = {}, seatsBy = {}, roomsBy = {};
  for (const s of pb.staff) sched[s.id] = { [X]: s.code };
  const nurses = pb.staff.map(s => ({ id: s.id, seniority: s.seniority, chargeCapable: s.chargeCapable }));
  if (L) for (const sh of L.shifts) {
    const dk = dks[pi - sh.back], key = dk + '|' + sh.P;
    for (const p of sh.people) {
      if (!sched[p.id]) { sched[p.id] = {}; nurses.push({ id: p.id, seniority: p.seniority, chargeCapable: p.chargeCapable }); }
      sched[p.id][dk] = sh.P;
    }
    seatsBy[key] = sh.seats; roomsBy[key] = sh.rooms;
    if (sh.pins) (ov[dk] = ov[dk] || {})[sh.P] = Object.assign({}, sh.pins);
  }
  const mine = (P, dk) => P === pb.P && dk === X;
  const opts = { rules: o.rules || rulesOf(pb.mask), seed, maxSeats: (P, cnt, dk) => mine(P, dk) ? pb.seats : seatsBy[dk + '|' + P] || 5 };
  if (pb.rooms) opts.roomsFor = (P, cnt, l, dk) => (mine(P, dk) ? pb.rooms[l] || [] : (roomsBy[dk + '|' + P] || {})[l] || []).slice();
  if (pb.bedsOf) opts.bedsOf = pb.bedsOf;
  if (pb.chargeSeats) opts.chargeSeats = (P, cnt, dk) => mine(P, dk) ? pb.chargeSeats.slice() : null;
  if (Object.keys(pb.ovr).length) (ov[X] = ov[X] || {})[pb.P] = Object.assign({}, pb.ovr);
  if (Object.keys(ov).length) opts.overrides = ov;
  if (Object.keys(avoid).length) opts.avoid = { [X]: { [pb.P]: JSON.parse(JSON.stringify(avoid)) } };
  if (pb.groups && !o.noGroups) opts.handoverGroups = JSON.parse(JSON.stringify(pb.groups));
  const res = compute(nurses, sched, dks, opts);
  const d = res.byDay[X][pb.P];
  const out = { labels: d.labels, extra: d.extra, charge: d.charge };
  if ('handover' in d) out.handover = d.handover;
  Object.defineProperty(out, 'res', { value: res });   // 앞 근무 확인용 (JSON 비교에는 안 들어간다)
  return out;
}
const same = (a, b) => JSON.stringify([a.labels, a.extra, a.charge]) === JSON.stringify([b.labels, b.extra, b.charge]);
const sameAll = (a, b) => same(a, b) && JSON.stringify(a.handover) === JSON.stringify(b.handover);
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

/* ─────────────────────────── 기록 ─────────────────────────── */
const fails = [];
const stat = {};
const count = k => { stat[k] = (stat[k] || 0) + 1; };
function fail(code, what, detail) {
  count('fail:' + code);
  if (fails.filter(f => f.code === code).length < 3) fails.push({ code, what, detail });
}

/* ─────────────────────────── 그룹 인계 검사 ─────────────────────────── */
// E13 — 넘겨받을 병상이 생길 수 있는 날: 엔진 배치의 값이 정답과 같다. 정답보다 좋으면 정답 쪽이 배치를 빠뜨린 것이다
function checkGroupBest(pb, d, cv, bf, tagF) {
  if (!bf.best || !gActive(pb)) return;
  count('E13');
  const c = cmp(bf.best.v, cv.v);
  if (c === 0) return;
  let k = 0; while (bf.best.v[k] === cv.v[k]) k++;
  fail('E13', VEC_NAMES[k] + (c > 0 ? ' 이 정답보다 나쁘다' : ' 이 정답보다 좋다 — 정답이 배치를 빠뜨렸다'),
    `${tagF()} 엔진값 ${cv.v} 정답값 ${bf.best.v} 정답 ${JSON.stringify(bf.seat)} 앞근무 ${JSON.stringify(pb.hold)} 그룹 ${JSON.stringify(pb.groups)}`);
}
// E16 — 피하지 못한 인계 알림 = 엔진이 고른 배치로 정답이 센 목록 (없으면 handover 가 아예 없다)
function checkReport(pb, d, tagF) {
  const want = handoverList(pb, d.labels), got = engineHandover(d);
  if (pb.hold && pb.groups) count('E16');
  if (JSON.stringify(want) !== JSON.stringify(got) || (!want.length && 'handover' in d))
    fail('E16', '피하지 못한 같은 그룹 인계 알림이 다르다', `${tagF()} 정답 ${JSON.stringify(want)} 엔진 ${JSON.stringify(got)} 앞근무 ${JSON.stringify(pb.hold)} 그룹 ${JSON.stringify(pb.groups)}`);
}
function checkGroups(pb, core, cv, bf, show) {
  checkGroupBest(pb, core, cv, bf, show);
  checkReport(pb, core, show);
  if (!pb.groups) return;
  // E14 — 그룹은 차지를 바꾸지 않는다 · E15 — 아무도 넘겨받을 수 없으면 그룹이 없는 것과 똑같다
  const ng = runCore(pb, { noGroups: true });
  count('E14');
  if (ng.charge !== core.charge) fail('E14', `그룹이 차지를 바꿨다 (그룹 없으면 ${ng.charge})`, show());
  if (!gActive(pb)) {
    count('E15');
    if (!sameAll(ng, core)) fail('E15', '넘겨받을 병상이 없는데 그룹이 결과를 바꿨다', JSON.stringify(Object.assign({ 그룹없음: ng }, JSON.parse(show()))));
  }
}

/* ─────────────────────────── 하루 검사 ─────────────────────────── */
function checkOne(pb, tag) {
  count('하루');
  const core = runCore(pb);
  const lay = pb.layer ? { 시간대: pb.P, 앞근무: pb.layer.kind, 그룹: pb.groups, 넘겨줄병상: pb.hold } : { 시간대: pb.P };
  const show = () => JSON.stringify(Object.assign({ 엔진: core }, tag, lay));
  // E1
  const seated = Object.values(core.labels), all = seated.concat(core.extra);
  if (all.length !== pb.staff.length || new Set(all).size !== all.length) fail('E1', '모두 한 번씩 앉지 않았다', show());
  if (pb.labels.some(l => !core.labels[l]) || Object.keys(core.labels).some(l => !pb.labels.includes(l))) fail('E1', '자리가 비거나 없는 자리에 앉았다', show());
  const noOvr = !Object.keys(pb.ovr).length;
  if (noOvr && core.charge !== chargeOf(pb)) fail('E1', `차지가 ${chargeOf(pb)} 이어야 하는데 ${core.charge}`, show());
  if (!pb.chargeSeats && noOvr && core.labels['차지'] !== core.charge) fail('E1', '자리 고정 서식인데 차지가 차지 자리에 없다', show());
  if (pb.chargeSeats && noOvr) {
    const cl = Object.keys(core.labels).find(l => core.labels[l] === core.charge);
    const allowed = pb.chargeSeats.filter(l => pb.labels.includes(l));
    if (allowed.length && !allowed.includes(cl)) fail('E1', `자유 차지가 허락되지 않은 자리 ${cl}`, show());
  }
  // S0 — 앞 근무가 손으로 정한 자리 그대로 (아니면 검사 쪽 pb.hold 가 엔진이 본 것과 다르다)
  if (pb.layer) for (const sh of pb.layer.shifts) {
    if (!sh.pins) continue;
    const d = core.res.byDay[pb.layer.dks[pb.layer.pi - sh.back]][sh.P];
    const want = {}; for (const id in sh.pins) want[sh.pins[id]] = id;
    const helpers = sh.people.map(p => p.id).filter(id => !(id in sh.pins));
    if (JSON.stringify(Object.entries(d.labels).sort()) !== JSON.stringify(Object.entries(want).sort()) || !sameSet(d.extra, helpers))
      fail('S0', '앞 근무가 손으로 정한 자리와 다르다', JSON.stringify({ 앞근무: d, 정한자리: want }) + ' ' + show());
  }
  // E2
  if (!sameAll(core, runCore(pb))) fail('E2', '같은 입력에 다른 결과', show());
  // E3 — 꺼 둔 원칙에 해당하는 기록은 지워도 결과가 같다 (앞 근무 자리에서 생긴 기록은 엔진 안에서 생겨 지울 수 없다)
  for (const id in pb.info) {
    const inf = pb.info[id];
    if (inf.fromPre) continue;
    if (tier(inf, pb.R, pb.P) >= 0 || (pb.R.bounceAfterOff && offReturner(inf))) continue;
    count('E3');
    const info2 = Object.assign({}, pb.info); delete info2[id];
    if (!same(core, runCore(pb, { info: info2 }))) fail('E3', `꺼 둔 원칙의 기록(${id})이 결과를 바꿨다`, show());
  }
  // E4
  const raw = rulesOf(pb.mask);
  if (raw.keepAfterOff) {
    count('E4');
    const a = runCore(pb, { rules: Object.assign({}, raw, { bounceAfterOff: true }) });
    const b = runCore(pb, { rules: Object.assign({}, raw, { bounceAfterOff: false }) });
    if (!same(a, b)) fail('E4', '원칙 3·4 를 둘 다 켰을 때가 원칙 3 만 켠 것과 다르다', show());
  }
  // E5
  const cv = vec(pb, core.labels, core.charge);
  const bf = best(pb, core.charge);
  if (bf.best && cmp(bf.best.v, cv.v) > 0) {
    let k = 0; while (bf.best.v[k] === cv.v[k]) k++;
    fail('E5', VEC_NAMES[k] + ' 이 정답보다 나쁘다',
      JSON.stringify(Object.assign({ 엔진값: cv.v, 정답값: bf.best.v, 정답: bf.seat }, JSON.parse(show()))));
  }
  checkGroups(pb, core, cv, bf, show);
  checkFull(pb, core, bf, show());
  // E6 — 원칙4: 같은 헬퍼·같거나 나은 값으로 튕김이 더 적은 배치
  if (pb.R.bounceAfterOff && cv.bo > 0) {
    count('E6');
    let alt = null;
    enumerate(pb, core.charge, (seat, ex) => {
      if (alt || !sameSet(ex, core.extra)) return;
      const v = vec(pb, seat, core.charge);
      if (cmp(v.v, cv.v) >= 0 && v.bo < cv.bo) alt = seat;
    });
    if (alt) fail('E6', '원칙 4: 튕김을 더 줄일 수 있었다', JSON.stringify(Object.assign({ 다른배치: alt }, JSON.parse(show()))));
  }
  // E7 — 원칙4 는 헬퍼를 바꾸지 않는다
  if (pb.R.bounceAfterOff) {
    count('E7');
    const off = runCore(pb, { rules: Object.assign({}, raw, { bounceAfterOff: false }) });
    if (!sameSet(core.extra, off.extra)) fail('E7', '원칙 4 가 헬퍼를 바꿨다', JSON.stringify(Object.assign({ 원칙4끔: off }, JSON.parse(show()))));
  }
  // E8 — 헬퍼는 후임 (이어 볼 것·주지 않을 방·손 고정이 없는 자리에 후임이 앉아 있으면 선임이 헬퍼일 수 없다)
  for (const h of core.extra) {
    const hs = pb.staff.find(n => n.id === h);
    for (const l in core.labels) {
      const s = core.labels[l];
      if (s === core.charge || s in pb.ovr) continue;
      const ss = pb.staff.find(n => n.id === s);
      if (hs.seniority >= ss.seniority) continue;
      if (cont(pb, s, l) || cont(pb, h, l)) continue;
      if ((pb.avoid[h] || []).includes(l) && !(pb.avoid[s] || []).includes(l)) continue;
      if (gOf(pb, h, l) > gOf(pb, s, l)) continue;           // 선임이 앉으면 같은 그룹 인계가 늘어난다 — 헬퍼보다 먼저
      fail('E8', `선임 ${h} 가 헬퍼인데 후임 ${s} 가 ${l} 에 앉았다`, show());
    }
  }
  // E9 — 주지 않을 방은 차지를 바꾸지 않는다
  if (Object.keys(pb.avoid).length && noOvr) {
    count('E9');
    if (runCore(pb, { avoid: {} }).charge !== core.charge) fail('E9', '주지 않을 방이 차지를 바꿨다', show());
  }
  // E12 — 차지가 자리에 안 묶이면 누가 CRN 이든 자리는 같다 (/CRN 은 사람에 붙는다). 102 실시간 수정에서 CRN 을 바꾸면 둘이 맞바뀌던 것.
  // '차지를 빼고 짠 배치' N 은 엔진 밖에서 셀 수 없으니 이렇게 찾는다: 손으로 자리를 정하지 않은 사람마다 CRN 을 맡겨(DC 표시, 모든 자리 허락)
  // 돌려 보면, N 에 앉아 있는 사람에게 맡긴 결과는 모두 N 이어야 한다 — 그런 배치('제 자리에 앉은 사람 누구에게 맡겨도 그대로')가 정확히 하나.
  // N 에서 헬퍼인 사람은 CRN 이 되면 앉아야 하니 다를 수 있다. 일부 자리만 허락하면(102 앞 세 자리처럼) N 의 그 사람 자리가 허락된 자리일 때만 N
  // 손으로 정하지 않은 자리가 하나뿐이면 건너뛴다 — CRN 을 맡긴 헬퍼가 그 자리에 앉은 배치는 앉은 사람이 그 하나라 저절로 '그대로'가 된다
  if (pb.chargeSeats && pb.labels.filter(l => !Object.values(pb.ovr).includes(l)).length >= 2) {
    const mk = pb.P + 'C', key = r => JSON.stringify([r.labels, r.extra]);
    const withChg = (p, X) => Object.assign({}, p, { staff: p.staff.map(n => Object.assign({}, n, { code: n.id === X ? mk : CHARGE[n.code] ? pb.P : n.code })) });
    const all = Object.assign({}, pb, { chargeSeats: LABELS.slice() });
    const free = pb.staff.filter(n => !(n.id in pb.ovr)).map(n => n.id), run = {};
    for (const X of free) run[X] = runCore(withChg(all, X));
    const seatIn = (r, id) => Object.keys(r.labels).find(l => r.labels[l] === id);
    const keys = [...new Set(free.map(X => key(run[X])))];
    const fixed = keys.filter(k => { const r = run[free.find(X => key(run[X]) === k)]; const on = free.filter(X => seatIn(r, X));
      return on.length && on.every(X => key(run[X]) === k); });
    count('E12');
    if (fixed.length !== 1) fail('E12', `CRN 을 누구에게 맡기느냐에 따라 자리가 바뀐다 (그대로인 배치 ${fixed.length}개)`,
      JSON.stringify(Object.assign({ 맡긴결과: Object.fromEntries(free.map(X => [X, run[X]])) }, JSON.parse(show()))));
    else if (pb.chargeSeats.length < LABELS.length) {
      const N = run[free.find(X => key(run[X]) === fixed[0])];
      for (const X of free) {
        const l = seatIn(N, X); if (!l || !pb.chargeSeats.includes(l)) continue;
        const r2 = runCore(withChg(pb, X));
        if (key(r2) !== fixed[0]) { fail('E12', `허락된 자리(${l})에 앉는 ${X} 에게 CRN 을 맡겼더니 자리가 바뀌었다`, JSON.stringify(Object.assign({ 맡긴뒤: r2, 차지를뺀배치: N }, JSON.parse(show())))); break; }
      }
    }
  }
}

/* ─────────────────────────── 여러 날 검사 ─────────────────────────── */
function checkMonth(run) {
  const r = rng(run * 9973 + 17);
  const nN = 5 + Math.floor(r() * 5), nD = 5 + Math.floor(r() * 6);
  const mask = Math.floor(r() * 16);
  const mode = pick(r, ['pinned', 'pinned', 'float', 'floatPart']);
  const seats = { D: pick(r, [4, 5, 5, 6]), E: pick(r, [4, 5, 5]), N: pick(r, [3, 4, 5]) };
  const nurses = []; for (let i = 0; i < nN; i++) nurses.push({ id: NAMES[i], seniority: i, chargeCapable: r() < (i < 4 ? 0.9 : 0.3) });
  const days = []; for (let d = 0; d < nD; d++) days.push('d' + String(d).padStart(2, '0'));
  const sched = {};
  for (const n of nurses) {                                  // 순방향 근무 (E→D·N→D·N→E 없음)
    sched[n.id] = {}; let prev = 'OF';
    for (const dk of days) {
      const allowed = prev === 'N' ? ['N', 'OF'] : prev === 'E' ? ['E', 'E', 'N', 'OF'] : ['D', 'D', 'D', 'E', 'N', 'OF', 'OF'];
      const c = pick(r, allowed); sched[n.id][dk] = c; prev = c;
    }
  }
  for (const dk of days) for (const P of ['D', 'E', 'N'])
    if (r() < 0.3) { const on = nurses.filter(n => sched[n.id][dk] === P); if (on.length) sched[pick(r, on).id][dk] = P + 'C'; }
  const scheme = {};
  for (const P of ['D', 'E', 'N']) { scheme[P] = {}; for (let k = 1; k <= 6; k++) { const parts = partition(r, k, r() < 0.7); scheme[P][k] = {}; LABELS.slice(0, k).forEach((l, i) => { scheme[P][k][l] = parts[i]; }); } }
  const roomsFor = (P, cnt, l) => ((scheme[P][Math.min(cnt, seats[P])] || {})[l] || []).slice();
  const bedMap = {}; ROOMS.forEach(x => { bedMap[x] = 1 + Math.floor(r() * 4); });
  const bedsOf = r() < 0.5 ? (t => bedMap[t] || 1) : null;
  const chargeSeats = mode === 'pinned' ? null : mode === 'float' ? () => LABELS.slice() : () => ['차지', 'A', 'B'];
  const seed = {};
  if (r() < 0.3) for (const n of nurses) if (r() < 0.5) seed[n.id] = { label: pick(r, LABELS.slice(0, 5)), period: pick(r, ['D', 'E', 'N']), idx: -1 };
  // 주지 않을 방 — 며칠은 한두 사람에게
  const avoidByDay = {};
  if (r() < 0.4) for (const dk of days) if (r() < 0.4) {
    const P = pick(r, ['D', 'E', 'N']); const who = pick(r, nurses).id;
    avoidByDay[dk] = { [P]: { [who]: shuffle(r, LABELS.slice(0, seats[P])).slice(0, 1 + Math.floor(r() * 2)) } };
  }
  const opts = { rules: rulesOf(mask), roomsFor, maxSeats: P => seats[P], seed, avoid: avoidByDay };
  if (bedsOf) opts.bedsOf = bedsOf;
  if (chargeSeats) opts.chargeSeats = chargeSeats;
  // 그룹 — 열에 여섯 달 (따로 뽑은 난수라 위 근무표는 그대로)
  const rg = rng(run * 7919 + 5);
  const groups = rg() < 0.6 ? {} : null;
  if (groups) { for (const n of nurses) { const g = grpOf(rg, GKEYS); if (g) groups[n.id] = g; } opts.handoverGroups = groups; }
  const res = compute(nurses, sched, days, opts);
  if (JSON.stringify(res) !== JSON.stringify(compute(nurses, sched, days, opts))) fail('E2', '여러 날 — 같은 입력에 다른 결과', 'run ' + run);
  const R = effRules(rulesOf(mask));
  count('한 달');
  // 엔진 결과로 '전에 본 방'을 따로 다시 쌓는다 (헬퍼는 방이 없어 기록을 바꾸지 않는다 — 엔진과 같다)
  const last = {};
  for (const id in seed) last[id] = { label: seed[id].label, idx: -1, period: seed[id].period, rooms: null };
  // 앞 근무에서 병상마다 본 사람 — 'dk|P' → {방: [자리에 앉은 사람]}. 근무자가 없던 근무는 없다(인계도 없다)
  const holdBy = {};
  for (let di = 0; di < days.length; di++) {
    const dk = days[di];
    for (const P of ['D', 'E', 'N']) {
      const staff = nurses.filter(n => sched[n.id][dk] === P || sched[n.id][dk] === P + 'C')
        .map(n => ({ id: n.id, seniority: n.seniority, chargeCapable: n.chargeCapable, code: sched[n.id][dk] }));
      if (!staff.length) continue;
      count('여러 날 시간대');
      const day = res.byDay[dk][P];
      const labels = LABELS.slice(0, Math.min(staff.length, seats[P]));
      const rooms = {}; labels.forEach(l => { rooms[l] = roomsFor(P, staff.length, l); });
      const info = {};
      for (const s of staff) if (last[s.id]) info[s.id] = Object.assign({}, last[s.id], { idx: last[s.id].idx - di });
      const avoid = ((avoidByDay[dk] || {})[P]) || {};
      const preKey = P === 'D' ? (di > 0 ? days[di - 1] + '|N' : null) : dk + '|' + PREV[P];
      const hold = groups && preKey ? holdBy[preKey] || null : null;
      const pb = { P, staff, labels, rooms, bedsOf, info, ovr: {}, avoid, chargeSeats: chargeSeats ? chargeSeats() : null, R, groups, hold };
      const tag = `run ${run} ${dk} ${P} 원칙 ${mask} ${mode} 엔진 ${JSON.stringify(day)}`;
      checkReport(pb, day, () => '여러 날 ' + tag);
      const hs = {};
      for (const l in day.labels) for (const t of rooms[l] || []) (hs[t] = hs[t] || []).push(day.labels[l]);
      holdBy[dk + '|' + P] = hs;
      const seated = Object.values(day.labels), all = seated.concat(day.extra);
      if (all.length !== staff.length || new Set(all).size !== all.length) fail('E1', '여러 날 — 모두 한 번씩 앉지 않았다', tag);
      if (labels.some(l => !day.labels[l])) fail('E1', '여러 날 — 빈 자리', tag);
      if (day.charge !== chargeOf(pb)) fail('E1', `여러 날 — 차지가 ${chargeOf(pb)} 이어야 한다`, tag);
      if (!pb.chargeSeats && day.labels['차지'] !== day.charge) fail('E1', '여러 날 — 차지가 차지 자리에 없다', tag);
      if (staff.length <= 7) {
        const cv = vec(pb, day.labels, day.charge);
        const bf = best(pb, day.charge);
        if (bf.best && cmp(bf.best.v, cv.v) > 0) fail('E5', '여러 날 — 정답보다 나쁜 배치', tag + ` 엔진값 ${cv.v} 정답값 ${bf.best.v} 정답 ${JSON.stringify(bf.seat)}`);
        checkGroupBest(pb, day, cv, bf, () => '여러 날 ' + tag);
        checkFull(pb, day, bf, '여러 날 ' + tag);
        if (R.bounceAfterOff && cv.bo > 0) {
          let alt = null;
          enumerate(pb, day.charge, (seat, ex) => {
            if (alt || !sameSet(ex, day.extra)) return;
            const v = vec(pb, seat, day.charge);
            if (cmp(v.v, cv.v) >= 0 && v.bo < cv.bo) alt = seat;
          });
          if (alt) fail('E6', '여러 날 — 원칙 4: 튕김을 더 줄일 수 있었다', tag + ' 다른 배치 ' + JSON.stringify(alt));
        }
      }
      for (const l in day.labels) last[day.labels[l]] = { label: l, idx: di, period: P, rooms: rooms[l] };
    }
  }
  // E10 — 하루 근무를 바꾸면 그 앞날은 그대로
  const k = 1 + Math.floor(r() * (nD - 1)), who = pick(r, nurses).id;
  const sched2 = JSON.parse(JSON.stringify(sched));
  sched2[who][days[k]] = sched[who][days[k]] === 'OF' ? 'D' : 'OF';
  const res2 = compute(nurses, sched2, days, opts);
  count('E10');
  for (let i = 0; i < k; i++)
    if (JSON.stringify(res.byDay[days[i]]) !== JSON.stringify(res2.byDay[days[i]])) { fail('E10', '뒷날 근무를 바꿨더니 앞날 배정이 바뀌었다', `run ${run} ${days[i]}`); break; }
}

/* ─────────────────────────── 차지 검사 ─────────────────────────── */
function checkCharge(runs) {
  let sd = 12345; const rnd = () => { sd = (sd * 48271) % 2147483647; return sd / 2147483647; };
  const pk = a => a[Math.floor(rnd() * a.length)];
  const SCH = {
    6: { 차지: ['12', '13', '14'], A: ['1', '2'], B: ['3', '4'], C: ['5', '10'], D: ['6', '7', '8'], E: ['9', '11'] },
    5: { 차지: ['12', '13', '14'], A: ['1', '2'], B: ['3', '4'], C: ['5', '10', '11'], D: ['6', '7', '8', '9'] },
    4: { 차지: ['1', '14'], A: ['2', '3', '12', '13'], B: ['4', '5', '11'], C: ['6', '7', '8', '9', '10'] },
    3: { 차지: ['1', '12', '13', '14'], A: ['2', '3', '4', '11'], B: ['5', '6', '7', '8', '9', '10'] },
    2: { 차지: ['1', '2', '12', '13', '14'], A: ['3', '4', '5', '6', '7', '8', '9', '10', '11'] },
    1: { 차지: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14'] },
  };
  const roomsFor = (P, cnt, l) => (SCH[Math.min(cnt, 6)] || SCH[5])[l] || [];
  const CODES = { D: ['D', 'DC'], E: ['E', 'EC'], N: ['N', 'NC'] };
  for (let run = 0; run < runs; run++) {
    const nN = 3 + Math.floor(rnd() * 9), nRel = rnd() < 0.3 ? 1 + Math.floor(rnd() * 2) : 0;
    const nurses = [];
    for (let i = 0; i < nN; i++) nurses.push({ id: 'n' + i, seniority: i,
      chargeCapable: rnd() < 0.5 ? { D: true, E: true, N: true } : rnd() < 0.5 ? { D: rnd() < 0.5, E: rnd() < 0.5, N: rnd() < 0.5 } : false });
    for (let i = 0; i < nRel; i++) nurses.push({ id: 'r' + i, seniority: nN + i, chargeCapable: false });   // 대체간호사
    const DK = []; for (let d = 0, n = 4 + Math.floor(rnd() * 5); d < n; d++) DK.push('2026-10-' + String(10 + d).padStart(2, '0'));
    const sc = {};
    for (const n of nurses) { sc[n.id] = {}; for (const dk of DK)
      sc[n.id][dk] = n.id[0] === 'r' ? (rnd() < 0.5 ? pk(['D', 'E', 'N']) : '') : pk(['D', 'D', 'E', 'E', 'N', 'OF', 'OF', 'DC', 'EC', 'NC', '/D', 'V']); }
    const float = rnd() < 0.5, useOv = rnd() < 0.35, useAv = rnd() < 0.35;
    const maxSeats = rnd() < 0.3 ? 6 : rnd() < 0.3 ? 4 : 5;
    const overrides = {}, avoid = {};
    if (useOv) for (const dk of DK) if (rnd() < 0.5) {
      const P = pk(['D', 'E', 'N']); const st = nurses.filter(n => CODES[P].includes(sc[n.id][dk]));
      if (st.length) { overrides[dk] = { [P]: {} }; overrides[dk][P][pk(st).id] = pk(LABELS.slice(0, Math.min(st.length, maxSeats))); }
    }
    if (useAv) for (const dk of DK) { avoid[dk] = {}; for (const P of ['D', 'E', 'N']) { avoid[dk][P] = {}; for (const n of nurses) if (rnd() < 0.3) avoid[dk][P][n.id] = [pk(LABELS)]; } }
    const allowed = LABELS.slice(0, Math.min(maxSeats, 4));
    const opts = { roomsFor, maxSeats, overrides: useOv ? overrides : undefined, avoid: useAv ? avoid : undefined,
      chargeSeats: float ? () => allowed.slice() : undefined, rules: { bounceAfterOff: rnd() < 0.2, keepAfterOff: rnd() < 0.8 } };
    // 절반은 그룹 (따로 뽑은 난수) — C4 가 그룹이 차지를 바꾸지 않는지도 본다
    const rg = rng(run * 131 + 11);
    if (rg() < 0.5) { const g = {}; for (const n of nurses) { const k = grpOf(rg, GKEYS); if (k) g[n.id] = k; } opts.handoverGroups = g; }
    const r = compute(nurses, sc, DK, opts);
    for (const dk of DK) for (const P of ['D', 'E', 'N']) {
      const staff = nurses.filter(n => CODES[P].includes(sc[n.id][dk]));
      const d = r.byDay[dk] && r.byDay[dk][P];
      const tag = `run ${run} ${dk} ${P} ${float ? '자유' : '고정'} ${JSON.stringify(d)}`;
      if (!staff.length) { if (d) fail('C1', '근무자가 없는데 배정이 있다', tag); continue; }
      count('차지 시간대');
      if (!d || !d.charge || !staff.some(n => n.id === d.charge)) { fail('C1', '차지가 그 근무 사람이 아니다', tag); continue; }
      const flags = Object.keys(r.byNurse).filter(id => r.byNurse[id][dk] && r.byNurse[id][dk].period === P && r.byNurse[id][dk].charge);
      if (flags.length !== 1 || flags[0] !== d.charge) fail('C2', '차지 깃발이 한 명이 아니다', tag);
      const seat = Object.keys(d.labels).find(l => d.labels[l] === d.charge);
      const ovHere = useOv && overrides[dk] && overrides[dk][P];
      if (!float && seat !== '차지') fail('C3', '자리 고정 서식인데 차지가 차지 자리가 아니다', tag);
      if (float && !seat) fail('C3', '자유 차지가 헬퍼가 됐다', tag);
      if (float && seat && !allowed.includes(seat) && !(ovHere && ovHere[d.charge])) fail('C3', '자유 차지가 허락되지 않은 자리', tag);
      if (ovHere) continue;
      const mk = staff.filter(n => CHARGE[sc[n.id][dk]]).sort(bySen)[0];
      const cap = staff.filter(n => chargeOk(n, P)).sort(bySen);
      const want = mk ? mk.id : cap.length ? cap[0].id : staff.slice().sort(bySen)[0].id;
      if (d.charge !== want) fail('C4', `차지가 ${want} 이어야 하는데 ${d.charge}`, tag);
      if (d.charge[0] === 'r' && cap.length) fail('C5', '차지 가능자가 근무하는데 대체간호사가 차지', tag);
    }
  }
}

/* ─────────────────────────── 실행 ─────────────────────────── */
const t0 = process.hrtime.bigint();
const N1 = Math.round(20000 * SCALE), N2 = Math.round(1500 * SCALE), N3 = Math.round(3000 * SCALE);
for (let s = 1; s <= N1; s++) {
  const pb = genProblem(s, { avoid: s % 3 === 0 });          // 셋에 하나는 주지 않을 방이 꼭 있다
  checkOne(pb, { 씨앗: s, 원칙: pb.mask, 차지: pb.mode });
}
for (let run = 1; run <= N2; run++) checkMonth(run);
checkCharge(N3);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

const counts = Object.entries(stat).filter(([k]) => !k.startsWith('fail:')).map(([k, v]) => `${k} ${v}`).join(' · ');
if (fails.length) {
  console.error('어싸인 원칙 검사 실패:');
  const byCode = {};
  for (const k in stat) if (k.startsWith('fail:')) byCode[k.slice(5)] = stat[k];
  console.error('  ' + Object.entries(byCode).map(([k, v]) => `${k} ${v}건`).join(' · '));
  for (const f of fails) console.error(`\n  [${f.code}] ${f.what}\n    ${f.detail}`);
  console.error(`\n  (${counts})`);
  process.exit(1);
}
assert.ok(stat['하루'] && stat['한 달'] && stat['차지 시간대']);
console.log(`어싸인 원칙 검사: 모두 통과 — ${counts} (${(ms / 1000).toFixed(1)}초)`);
