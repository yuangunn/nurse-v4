/* ────────────────────────────────────────────────────────────────────────────
 * 어싸인 배정 핵심 로직 (순수 함수 — Alpine/DOM 무관)
 *
 * 단일 소스: 앱 어싸인 탭과 standalone/assign.html 둘 다 이 파일을 사용.
 * standalone 갱신: node scripts/build-assign-standalone.mjs
 *
 * 원칙:
 *  1. 차지 = 근무표 DC/EC/NC 표시자 우선, 없으면 차지가능자 중 최선임.
 *  2. 전일 같은 근무에서 본 방 유지 (최우선).
 *  3. 전일 다른 근무에서 본 방 유지 (2항 다음).
 *  4. 오프 복귀자 봤던 방 유지 (3항 다음).
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

  /**
   * @param nurses   [{id, seniority(작을수록 선임), chargeCapable}]
   * @param schedule {nurseId: {dateKey: code}}
   * @param dateKeys 시간순 날짜키 배열 (연속성 위해 전월 이월일 포함 가능)
   * @param opts     {rules:{keepSameShift,keepAcrossShift,keepAfterOff},
   *                  overrides:{dateKey:{P:{nurseId:label}}}}
   * @returns {byDay:{dk:{P:{labels:{label:nurseId}, extra:[nurseId]}}},
   *           byNurse:{nurseId:{dk:{period,label}}}}
   */
  function compute(nurses, schedule, dateKeys, opts) {
    opts = opts || {};
    const rules = Object.assign(
      { keepSameShift: true, keepAcrossShift: true, keepAfterOff: true },
      opts.rules || {}
    );
    const overrides = opts.overrides || {};
    const byDay = {}, byNurse = {};
    const lastSeen = {}; // nurseId -> {label, idx, period}

    for (let idx = 0; idx < dateKeys.length; idx++) {
      const dk = dateKeys[idx];
      for (const P in PERIOD_CODES) {
        const staff = nurses.filter(function (n) {
          return periodOf((schedule[n.id] || {})[dk]) === P;
        });
        if (!staff.length) continue;

        const labels = LABELS.slice(0, Math.min(staff.length, 5));
        const assigned = {}; // label -> nurse
        const taken = {};    // nurseId -> true
        const freeLabels = function () {
          return labels.filter(function (l) { return !assigned[l]; });
        };

        // 0) 수동 오버라이드 최우선
        const ov = (overrides[dk] || {})[P] || {};
        for (const nid in ov) {
          const nurse = staff.find(function (n) { return n.id === nid; });
          const label = ov[nid];
          if (nurse && labels.indexOf(label) >= 0 && !assigned[label]) {
            assigned[label] = nurse; taken[nid] = true;
          }
        }

        // 1) 차지: DC/EC/NC 표시자 → 차지가능 최선임 → 최선임
        if (!assigned['차지']) {
          let c = staff.find(function (n) {
            return !taken[n.id] && CHARGE_CODES[(schedule[n.id] || {})[dk]];
          });
          if (!c) {
            const pool = staff.filter(function (n) { return !taken[n.id] && n.chargeCapable; });
            const cand = (pool.length ? pool : staff.filter(function (n) { return !taken[n.id]; }))
              .slice().sort(function (a, b) { return a.seniority - b.seniority; });
            c = cand[0];
          }
          if (c) { assigned['차지'] = c; taken[c.id] = true; }
        }

        // 2~4) 연속성 계층 — 앞 계층이 항상 우선
        const tiers = [];
        if (rules.keepSameShift) tiers.push(function (info) { return info.idx === idx - 1 && info.period === P; });
        if (rules.keepAcrossShift) tiers.push(function (info) { return info.idx === idx - 1 && info.period !== P; });
        if (rules.keepAfterOff) tiers.push(function (info) { return info.idx < idx - 1; });

        for (let t = 0; t < tiers.length; t++) {
          const claims = {}; // label -> [{n, info}]
          const free = freeLabels();
          for (let s = 0; s < staff.length; s++) {
            const n = staff[s];
            if (taken[n.id]) continue;
            const info = lastSeen[n.id];
            if (info && tiers[t](info) && free.indexOf(info.label) >= 0) {
              (claims[info.label] = claims[info.label] || []).push({ n: n, info: info });
            }
          }
          for (const label in claims) {
            claims[label].sort(function (a, b) {
              return b.info.idx - a.info.idx || a.n.seniority - b.n.seniority;
            });
            assigned[label] = claims[label][0].n; taken[claims[label][0].n.id] = true;
          }
        }

        // 5) 잔여: 선임 순으로 남은 라벨 채움
        const leftover = staff.filter(function (n) { return !taken[n.id]; })
          .sort(function (a, b) { return a.seniority - b.seniority; });
        const rem = freeLabels();
        for (let i = 0; i < rem.length && leftover.length; i++) {
          const n = leftover.shift();
          assigned[rem[i]] = n; taken[n.id] = true;
        }
        // 6인 이상: 라벨 소진 후 잔여 인원은 어싸인 없음(헬퍼)
        const extra = leftover.map(function (n) { return n.id; });

        const labelMap = {};
        for (const l in assigned) {
          const n = assigned[l];
          labelMap[l] = n.id;
          lastSeen[n.id] = { label: l, idx: idx, period: P };
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
