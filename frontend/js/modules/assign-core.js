/* ────────────────────────────────────────────────────────────────────────────
 * 어싸인 배정 핵심 로직 (순수 함수 — Alpine/DOM 무관)
 *
 * 단일 소스: 앱 어싸인 탭과 standalone/assign.html 둘 다 이 파일을 사용.
 * standalone 갱신: node scripts/build-assign-standalone.mjs
 *
 * 원칙:
 *  차지 = 근무표 DC/EC/NC 표시자 우선, 없으면 차지가능자 중 최선임 (항상 적용).
 *  1. 전일 같은 근무에서 본 방 유지 (최우선).
 *  2. 전일 다른 근무에서 본 방 유지 (1항 다음).
 *  3. 오프 복귀자 봤던 방 유지 (2항 다음).
 *  4. 오프 복귀자 튕기기 — 잔여 배정에서 이전 방 회피 (3과 동시 사용 불가,
 *     동시 켜지면 3이 우선). 대안이 없으면 그대로 배정 (라벨 미충원 방지).
 *
 * '방 유지'의 기준 — opts.roomsFor 제공 시 **실제 병실 기준** (라벨 기준 아님):
 *  A인 사람이 계속 A인 이유는 보는 병실(= 환자)이 같아서다. 인원이 바뀌는 날
 *  (5인→4인)은 방 구성이 통째로 달라지므로 라벨을 이으면 방이 어긋난다.
 *  → 전에 본 병실과 오늘 각 라벨의 병실이 겹치는 정도로 짝지어, 전날 6~9호를
 *    본 사람이 오늘 6~10호 라벨을 가져간다. 겹침 총합이 최대가 되도록 배정
 *    (할당 문제 — 라벨 ≤5라 비트마스크 DP로 정확 해).
 *  방 정보가 없는 자리(스킴 미정의·시드·roomsFor 미제공)나 겹치는 방이 아예
 *  없을 때만 기존처럼 라벨 일치로 폴백한다.
 * ─────────────────────────────────────────────────────────────────────────── */
(function (root) {
  const PERIOD_CODES = { D: ['DC', 'D'], E: ['EC', 'E'], N: ['NC', 'N'] };
  const CHARGE_CODES = { DC: 1, EC: 1, NC: 1 };
  const LABELS = ['차지', 'A', 'B', 'C', 'D'];

  // 근무코드 → 'D'|'E'|'N'|null (중간번·D1·트레이니(/) 등은 어싸인 제외)
  function periodOf(code) {
    if (!code || code.charAt(0) === '/') return null;
    for (const p in PERIOD_CODES) if (PERIOD_CODES[p].indexOf(code) >= 0) return p;
    return null;
  }

  // chargeCapable: boolean(전 시간대) 또는 {D,E,N} 시간대별 — 하위호환
  function chargeOk(n, P) {
    const c = n.chargeCapable;
    return c && typeof c === 'object' ? !!c[P] : !!c;
  }

  // 방 토큰 교집합 크기 — 방 기준 연속성의 점수
  function overlap(a, b) {
    if (!a || !b || !a.length || !b.length) return 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) n++;
    return n;
  }

  /* 최대 총 가중치 매칭 — W[i][j] = 간호사 i를 라벨 j에 둘 때 점수(0 = 불가).
   * 라벨이 최대 5개라 라벨 집합을 비트마스크로 두고 정확한 최적해를 구한다
   * (그리디는 "겹침 4를 잡느라 다른 사람 겹침 3을 통째로 날리는" 선택을 함). */
  function maxMatch(W, nL) {
    const full = 1 << nL;
    let dp = new Array(full).fill(-1);
    dp[0] = 0;
    const choice = [];
    for (let i = 0; i < W.length; i++) {
      const ndp = new Array(full).fill(-1), ch = new Array(full).fill(-1);
      for (let m = 0; m < full; m++) {
        if (dp[m] < 0) continue;
        if (dp[m] > ndp[m]) { ndp[m] = dp[m]; ch[m] = -1; }   // i를 비움
        for (let j = 0; j < nL; j++) {
          if (m & (1 << j)) continue;
          const w = W[i][j];
          if (w <= 0) continue;
          const nm = m | (1 << j), v = dp[m] + w;
          if (v > ndp[nm]) { ndp[nm] = v; ch[nm] = j; }
        }
      }
      dp = ndp; choice.push(ch);
    }
    let best = 0;
    for (let m = 1; m < full; m++) if (dp[m] > dp[best]) best = m;
    const pairs = [];
    for (let i = W.length - 1; i >= 0; i--) {
      const j = choice[i][best];
      if (j >= 0) { pairs.push([i, j]); best ^= (1 << j); }
    }
    return pairs;
  }

  /**
   * @param nurses   [{id, seniority(작을수록 선임), chargeCapable: bool|{D,E,N}}]
   * @param schedule {nurseId: {dateKey: code}}
   * @param dateKeys 시간순 날짜키 배열 (연속성 위해 전월 이월일 포함 가능)
   * @param opts     {rules:{keepSameShift,keepAcrossShift,keepAfterOff,bounceAfterOff},
   *                  overrides:{dateKey:{P:{nurseId:label}}},
   *                  seed:{nurseId:{label,period,idx,rooms?}},  idx<0 = 전월 (말일=-1)
   *                  avoid:{dateKey:{P:{nurseId:[label]}}},  금지 방 등 회피 라벨 (소프트 —
   *                  대안 없으면 그대로 배정, 수동 오버라이드·DC/EC/NC 표시자는 회피 무시)
   *                  roomsFor:(P,cnt,label,dateKey)=>[방 토큰]}  ← 주면 방 기준 연속성
   * @returns {byDay:{dk:{P:{labels:{label:nurseId}, extra:[nurseId]}}},
   *           byNurse:{nurseId:{dk:{period,label}}}}
   */
  function compute(nurses, schedule, dateKeys, opts) {
    opts = opts || {};
    const rules = Object.assign(
      { keepSameShift: true, keepAcrossShift: true, keepAfterOff: true, bounceAfterOff: false },
      opts.rules || {}
    );
    // 원칙3(유지)·원칙4(튕기기)는 반대 개념 — 동시 켜지면 원칙3만 적용
    if (rules.keepAfterOff && rules.bounceAfterOff) rules.bounceAfterOff = false;
    const overrides = opts.overrides || {};
    const avoid = opts.avoid || {};
    const roomsFor = opts.roomsFor || null;
    const byDay = {}, byNurse = {};
    const lastSeen = {}; // nurseId -> {label, idx, period, rooms}
    // 전월 연속성 시드 — 전월에 마지막으로 본 방을 상대 idx로 주입하면 원칙1~4가 월 경계를 넘어 작동.
    // idx는 dateKeys[0] 기준 상대값: 음수 = dateKeys 이전, 0 이상 = 이월(오버플로) 구간과 겹침
    // (겹치는 날에 현재 데이터로 배정이 일어나면 자연히 덮어써진다).
    const seed = opts.seed || {};
    for (const nid in seed) {
      const s = seed[nid];
      if (s && s.label && typeof s.idx === 'number' && s.idx < dateKeys.length)
        lastSeen[nid] = { label: s.label, idx: s.idx, period: s.period, rooms: s.rooms || null };
    }

    for (let idx = 0; idx < dateKeys.length; idx++) {
      const dk = dateKeys[idx];
      for (const P in PERIOD_CODES) {
        const staff = nurses.filter(function (n) {
          return periodOf((schedule[n.id] || {})[dk]) === P;
        });
        if (!staff.length) continue;

        const labels = LABELS.slice(0, Math.min(staff.length, 5));
        const av = (avoid[dk] || {})[P] || {};
        const avOk = function (nid, label) { return (av[nid] || []).indexOf(label) < 0; };
        const assigned = {}; // label -> nurse
        const taken = {};    // nurseId -> true
        const freeLabels = function () {
          return labels.filter(function (l) { return !assigned[l]; });
        };
        // 오늘 이 시간대의 라벨별 실제 병실 (인원수 cnt 기준 — 그날 방 구성 + 수기 수정 반영)
        const cnt = staff.length;
        const roomsByLabel = {};
        if (roomsFor) for (let i = 0; i < labels.length; i++)
          roomsByLabel[labels[i]] = roomsFor(P, cnt, labels[i], dk) || [];

        // 0) 수동 오버라이드 최우선 (회피 라벨보다도 우선 — 복구 패스에서 건드리지 않음)
        const ov = (overrides[dk] || {})[P] || {};
        const ovIds = {};
        for (const nid in ov) {
          const nurse = staff.find(function (n) { return n.id === nid; });
          const label = ov[nid];
          if (nurse && labels.indexOf(label) >= 0 && !assigned[label]) {
            assigned[label] = nurse; taken[nid] = true; ovIds[nid] = true;
          }
        }

        // 1) 차지: DC/EC/NC 표시자 → 차지가능 최선임 → 최선임
        if (!assigned['차지']) {
          let c = staff.find(function (n) {
            return !taken[n.id] && CHARGE_CODES[(schedule[n.id] || {})[dk]];
          });
          if (!c) {
            const pool = staff.filter(function (n) { return !taken[n.id] && chargeOk(n, P); });
            const pref = pool.filter(function (n) { return avOk(n.id, '차지'); });
            const base = pref.length ? pref : (pool.length ? pool : staff.filter(function (n) { return !taken[n.id]; }));
            c = base.slice().sort(function (a, b) { return a.seniority - b.seniority; })[0];
          }
          if (c) { assigned['차지'] = c; taken[c.id] = true; }
        }

        // 2~4) 연속성 — 원칙 우선순위(1 > 2 > 3)는 그대로, 자리 배치만 함께 푼다
        const tierOf = function (info) {
          if (rules.keepSameShift && info.idx === idx - 1 && info.period === P) return 0;   // 원칙1
          if (rules.keepAcrossShift && info.idx === idx - 1 && info.period !== P) return 1;  // 원칙2
          if (rules.keepAfterOff && info.idx < idx - 1) return 2;                            // 원칙3
          return -1;
        };
        const cand = staff.filter(function (n) {
          return !taken[n.id] && lastSeen[n.id] && tierOf(lastSeen[n.id]) >= 0;
        });

        // (a) 방 기준 매칭 — 세 원칙을 한 번에 푼다.
        //     점수는 계층이 절대 우선(원칙1을 한 명이라도 더 앉히는 쪽이 언제나 이김),
        //     그 다음 겹친 병실 수, 동점이면 최근에 본 사람 → 선임 순.
        //     한 번에 푸는 이유: 원칙1인 사람이 두 자리에 무차별할 때(양쪽 겹침 동일)
        //     오프 복귀자가 원래 보던 방을 되찾도록 자리를 비켜 줄 수 있다.
        if (roomsFor && cand.length) {
          const TIER_W = [10000000000, 1000000000, 0];
          const free = freeLabels().filter(function (l) { return roomsByLabel[l].length; });
          if (free.length) {
            const W = cand.map(function (n) {
              const info = lastSeen[n.id];
              const tw = TIER_W[tierOf(info)];
              const recency = Math.max(-400, Math.min(400, info.idx)) + 400;   // 0~800
              return free.map(function (l) {
                if (!avOk(n.id, l)) return 0;
                const o = Math.min(30, overlap(info.rooms, roomsByLabel[l]));
                if (!o) return 0;
                return tw + o * 1000000 + recency * 1000 + Math.max(0, 999 - n.seniority);
              });
            });
            const pairs = maxMatch(W, free.length);
            for (let k = 0; k < pairs.length; k++) {
              const n = cand[pairs[k][0]], l = free[pairs[k][1]];
              assigned[l] = n; taken[n.id] = true;
            }
          }
        }

        // (b) 라벨 유지 폴백 — 방 정보가 없거나 겹치는 방이 하나도 없을 때만.
        //     여긴 원칙 순서대로(1→2→3) 훑는다.
        for (let t = 0; t < 3; t++) {
          const claims = {}; // label -> [{n, info}]
          const free2 = freeLabels();
          for (let s = 0; s < cand.length; s++) {
            const n = cand[s];
            if (taken[n.id]) continue;
            const info = lastSeen[n.id];
            if (tierOf(info) !== t) continue;
            if (free2.indexOf(info.label) < 0 || !avOk(n.id, info.label)) continue;
            (claims[info.label] = claims[info.label] || []).push({ n: n, info: info });
          }
          for (const label in claims) {
            claims[label].sort(function (a, b) {
              return b.info.idx - a.info.idx || a.n.seniority - b.n.seniority;
            });
            assigned[label] = claims[label][0].n; taken[claims[label][0].n.id] = true;
          }
        }

        // 잔여: 선임 순으로 남은 라벨 채움
        // 원칙4(튕기기): 오프 복귀자는 이전에 보던 방을 피해 배정 — 대안 없으면 그대로
        const leftover = staff.filter(function (n) { return !taken[n.id]; })
          .sort(function (a, b) { return a.seniority - b.seniority; });
        const rem = freeLabels();
        for (let i = 0; i < rem.length && leftover.length; i++) {
          const bounceOk = function (n) {
            if (!rules.bounceAfterOff) return true;
            const info = lastSeen[n.id];
            if (!info || !(info.idx < idx - 1)) return true;
            if (roomsFor && info.rooms && info.rooms.length && roomsByLabel[rem[i]].length)
              return !overlap(info.rooms, roomsByLabel[rem[i]]);
            return info.label !== rem[i];
          };
          // 회피 라벨(금지 방)과 원칙4 둘 다 통과 → 회피만 통과 → 아무나 (미충원 방지)
          let pick = leftover.findIndex(function (n) { return avOk(n.id, rem[i]) && bounceOk(n); });
          if (pick < 0) pick = leftover.findIndex(function (n) { return avOk(n.id, rem[i]); });
          if (pick < 0) pick = 0;
          const n = leftover.splice(pick, 1)[0];
          assigned[rem[i]] = n; taken[n.id] = true;
        }
        // 6인 이상: 라벨 소진 후 잔여 인원은 어싸인 없음(헬퍼)
        const extra = leftover.map(function (n) { return n.id; });

        // 회피 라벨 복구: 회피 라벨에 배정된 간호사를 서로 문제 없는 상대와 맞교환.
        // 연속성(원칙1~3)보다 회피(금지 방)가 우선 — 수동 오버라이드·차지는 건드리지 않음.
        for (const l in assigned) {
          if (l === '차지') continue;
          const n = assigned[l];
          if (avOk(n.id, l) || ovIds[n.id]) continue;
          for (const l2 in assigned) {
            if (l2 === l || l2 === '차지') continue;
            const m = assigned[l2];
            if (!ovIds[m.id] && avOk(n.id, l2) && avOk(m.id, l)) {
              assigned[l] = m; assigned[l2] = n; break;
            }
          }
        }

        const labelMap = {};
        for (const l in assigned) {
          const n = assigned[l];
          labelMap[l] = n.id;
          lastSeen[n.id] = { label: l, idx: idx, period: P, rooms: roomsByLabel[l] || null };
          (byNurse[n.id] = byNurse[n.id] || {})[dk] = { period: P, label: l };
        }
        for (let i = 0; i < extra.length; i++) {
          (byNurse[extra[i]] = byNurse[extra[i]] || {})[dk] = { period: P, label: null };
        }
        (byDay[dk] = byDay[dk] || {})[P] = { labels: labelMap, extra: extra };
      }
    }
    return { byDay: byDay, byNurse: byNurse };
  }

  const api = { compute: compute, periodOf: periodOf, LABELS: LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AssignCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
