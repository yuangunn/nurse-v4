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
 *     꺼져 있으면 아무 일도 하지 않는다. 켜도 누가 헬퍼가 되는지는 정하지 않는다.
 *
 * 마지막 다듬기 — 위 단계(방 매칭 → 라벨 폴백 → 남은 자리)로 채운 뒤, 손으로 고정한 자리와 차지를 뺀
 *  자리 전부를 **다 따져 보고** 가장 나은 배치로 바꾼다. 사전식으로
 *  주지 않을 방에 앉는 사람 수(적게) > 이어 보기(원칙 1 > 2 > 3 사람 수, 그다음 겹친 병상) > 헬퍼는 후임
 *  > 원칙 4 튕기기(켰을 때) > 같은 점수면 누가 잇는지(최근에 본 사람 → 선임) > 위 단계 배치에서 덜 움직이기. 예전엔 주지 않을 방을 피하려고 둘씩 맞바꿨는데,
 *  상대가 어제 같은 근무로 이어 보던 사람이면 원칙 1 이 깨졌고 셋이 돌아가며 바꿔야 풀리는 날은 못 풀었다 (2026-10-01 검증).
 *
 * '방 유지'의 기준 — opts.roomsFor 제공 시 **실제 병실 기준** (라벨 기준 아님):
 *  A인 사람이 계속 A인 이유는 보는 병실(= 환자)이 같아서다. 인원이 바뀌는 날
 *  (5인→4인)은 방 구성이 통째로 달라지므로 라벨을 이으면 방이 어긋난다.
 *  → 전에 본 병실과 오늘 각 라벨의 병실이 겹치는 정도로 짝지어, 전날 6~9호를
 *    본 사람이 오늘 6~10호 라벨을 가져간다. 겹침 총합이 최대가 되도록 배정
 *    (할당 문제 — 라벨 ≤6이라 비트마스크 DP로 정확 해).
 *  방 정보가 없는 자리(스킴 미정의·시드·roomsFor 미제공)나 겹치는 방이 아예
 *  없을 때만 기존처럼 라벨 일치로 폴백한다.
 *
 * 자리 수 — 기본 5(차지·A·B·C·D). 양식에 D 가 6줄인 병동(122: 대체간호사가 오는 날)은
 *  opts.maxSeats 로 6번째 자리(E)를 연다. 자리보다 사람이 많으면 남는 사람은 헬퍼(extra).
 *
 * 차지 자리 — 기본은 차지가 '차지' 자리(차지 방)에 앉는다(101 의 A(CN), 122 의 CN).
 *  opts.chargeSeats 가 자리 목록을 주면 그 근무의 차지는 **방이 정해져 있지 않다**: 사람은 똑같이
 *  고르되 그 목록 중 한 자리에 앉고, 어느 자리인지는 연속성이 정한다. 102 병동은 CRN 이 종이의
 *  어느 자리(A·B·C·D)든 보는데, 차지를 첫 자리에 못 박으면 CRN 이 바뀌는 날마다 모두의 자리가 한 칸씩 밀려
 *  뒤가 하나도 이어지지 않았다 (2026-10-01). 그때 '차지' 는 그냥 첫 자리 이름이다.
 *  자리는 후보마다 나머지 배정을 실제로 돌려 보고 고른다 — 금지 방에 앉는 사람이 가장 적고, 그다음 모두가
 *  이어 보는 병실이 가장 많은 자리. 이어 볼 것이 없으면 차지가 아닐 때 앉았을 자리(CRN 을 바꿔도 아무도 안 밀린다).
 *  누가 차지인지는 결과의 byDay[dk][P].charge · byNurse[id][dk].charge 로 준다(자리가 고정이어도).
 *  차지 사람은 주지 않을 방과 상관없이 고른다(시니어리티) — 자리가 고정인 서식에서 차지 방에 주지 않을 방이 있으면
 *  차지가 그 방에 앉고 경고로 알린다. 예전엔 그 사람을 말없이 차지에서 빼, 인원이 바뀌는 날마다 차지가 오갔다.
 *
 * 그룹 인계 피하기 — opts.handoverGroups 가 {간호사: [그룹]} 를 주면 **같은 그룹 사람끼리** 바로 앞 근무에서 본 병상을
 *  넘겨받지 않게 자리를 고른다(갓 독립한 신규끼리 인계하지 않게, 2026-10-09 사용자). 앞 근무 = D 는 전날 N, E 는 같은 날 D,
 *  N 은 같은 날 E — 앞 근무는 이미 정해진 것으로 보고 뒤 근무가 피한다. 잣대는 넘겨받는 병상 수 합(같은 그룹 사람이 본 병상을
 *  같은 그룹 사람이 받으면 그 병상 수). 사전식으로 **주지 않을 방 다음, 이어 보기(원칙 1~3)보다 먼저** — 이어 보기가 먼저면
 *  어제 방을 그대로 잇는 두 사람이 매일 같은 환자를 주고받아 거의 효과가 없다. 대신 겹치던 사람이 한 번 방을 옮기고, 그 뒤로는
 *  이어 보기가 둘을 떼어 둔다. 누가 차지인지는 바꾸지 않는다. 방 정보(roomsFor)가 없으면 아무 일도 하지 않는다.
 *  피하지 못한 인계는 결과의 byDay[dk][P].handover = [{from, to, rooms}] 로 알린다.
 * ─────────────────────────────────────────────────────────────────────────── */
(function (root) {
  const PERIOD_CODES = { D: ['DC', 'D'], E: ['EC', 'E'], N: ['NC', 'N'] };
  const CHARGE_CODES = { DC: 1, EC: 1, NC: 1 };
  const LABELS = ['차지', 'A', 'B', 'C', 'D', 'E'];
  const DEFAULT_SEATS = 5;

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

  // 방 토큰 교집합 — 방 기준 연속성의 점수. bedsOf(token→병상수)가 있으면 겹친 병상수 합
  // (같이 보던 환자 수 기준), 없으면 겹친 방 개수. 병상수를 모르는 방은 1로 센다.
  function overlap(a, b, bedsOf) {
    if (!a || !b || !a.length || !b.length) return 0;
    let n = 0;
    for (let i = 0; i < a.length; i++)
      if (b.indexOf(a[i]) >= 0) n += bedsOf ? Math.max(1, +bedsOf(a[i]) || 1) : 1;
    return n;
  }

  /* 최대 총 가중치 매칭 — W[i][j] = 간호사 i를 라벨 j에 둘 때 점수(0 = 불가).
   * 라벨이 최대 6개라 라벨 집합을 비트마스크로 두고 정확한 최적해를 구한다
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
   *                  bedsOf:(token)=>병상수  ← 주면 겹침을 방 개수가 아니라 병상수 합으로 잰다
   *                  overrides:{dateKey:{P:{nurseId:label}}},
   *                  seed:{nurseId:{label,period,idx,rooms?}},  idx<0 = 전월 (말일=-1)
   *                  avoid:{dateKey:{P:{nurseId:[label]}}},  금지 방 등 회피 라벨 (소프트 —
   *                  대안 없으면 그대로 배정, 수동 오버라이드·DC/EC/NC 표시자는 회피 무시)
   *                  roomsFor:(P,cnt,label,dateKey)=>[방 토큰],  ← 주면 방 기준 연속성
   *                  maxSeats: 숫자 또는 (P,cnt,dateKey)=>숫자  ← 자리 수(1~6, 기본 5)
   *                  chargeSeats:(P,cnt,dateKey)=>[라벨]|null  ← 주면 차지가 그 자리 중 한 곳에 (방이 고정이 아닌 차지)
   *                  handoverGroups:{nurseId:[그룹]}  ← 주면 같은 그룹끼리 앞 근무의 병상을 넘겨받지 않게 (주지 않을 방 다음, 원칙 1~3 보다 먼저)}
   * @returns {byDay:{dk:{P:{labels:{label:nurseId}, extra:[nurseId], charge:nurseId,
   *                        handover?:[{from:nurseId, to:nurseId, rooms:[방 토큰]}]}}},  ← 피하지 못한 같은 그룹 인계
   *           byNurse:{nurseId:{dk:{period,label,charge?:true}}}}
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
    const bedsOf = opts.bedsOf || null;
    const seatsOf = function (P, cnt, dk) {
      const v = typeof opts.maxSeats === 'function' ? opts.maxSeats(P, cnt, dk) : opts.maxSeats;
      return Math.max(1, Math.min(LABELS.length, Math.floor(+v) || DEFAULT_SEATS));
    };
    const byDay = {}, byNurse = {};
    const lastSeen = {}; // nurseId -> {label, idx, period, rooms}
    // 그룹 인계 피하기 — 같은 그룹(하나라도 겹치면) 다른 사람끼리만. 그룹이 없으면 아무 일도 하지 않는다
    const hGroups = {};
    let hOn = false;
    if (opts.handoverGroups && roomsFor) for (const nid in opts.handoverGroups) {
      const g = [].concat(opts.handoverGroups[nid] || []).map(String).filter(Boolean);
      if (g.length) { hGroups[nid] = g; hOn = true; }
    }
    const sameGroup = function (a, b) {
      if (a === b || !hGroups[a] || !hGroups[b]) return false;
      for (let i = 0; i < hGroups[a].length; i++) if (hGroups[b].indexOf(hGroups[a][i]) >= 0) return true;
      return false;
    };
    // 바로 앞 근무(D ← 전날 N, E ← D, N ← E)에서 병상마다 누가 봤나 — {idx, P, holders:{토큰:[nurseId]}}
    let prevShift = null;
    const PREV_OF = { D: 'N', E: 'D', N: 'E' };
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

        const labels = LABELS.slice(0, Math.min(staff.length, seatsOf(P, staff.length, dk)));
        const av = (avoid[dk] || {})[P] || {};
        const avOk = function (nid, label) { return (av[nid] || []).indexOf(label) < 0; };
        const assigned = {}; // label -> nurse
        const taken = {};    // nurseId -> true
        // 오늘 이 시간대의 라벨별 실제 병실 (인원수 cnt 기준 — 그날 방 구성 + 수기 수정 반영)
        const cnt = staff.length;
        const roomsByLabel = {};
        if (roomsFor) for (let i = 0; i < labels.length; i++)
          roomsByLabel[labels[i]] = roomsFor(P, cnt, labels[i], dk) || [];

        // 그룹 인계 — 바로 앞 근무가 정해져 있을 때만 (D 는 전날 N, E·N 은 같은 날 앞 근무. 그 근무에 아무도 없었으면 인계도 없다)
        const holders = hOn && prevShift && prevShift.P === PREV_OF[P] &&
          prevShift.idx === (P === 'D' ? idx - 1 : idx) ? prevShift.holders : null;
        // 이 사람이 이 자리에 앉으면 같은 그룹 사람이 앞 근무에서 본 병상을 몇 개 넘겨받나 (병상수 합 — 겹침과 같은 잣대)
        const handW = function (n, l) {
          if (!holders || !hGroups[n.id]) return 0;
          const rs = roomsByLabel[l] || [];
          let w = 0;
          for (let i = 0; i < rs.length; i++) {
            const hs = holders[rs[i]];
            if (!hs) continue;
            for (let k = 0; k < hs.length; k++)
              if (sameGroup(hs[k], n.id)) { w += bedsOf ? Math.max(1, +bedsOf(rs[i]) || 1) : 1; break; }
          }
          return w;
        };

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

        // 연속성 등급 — 원칙 우선순위(1 > 2 > 3)
        const tierOf = function (info) {
          if (rules.keepSameShift && info.idx === idx - 1 && info.period === P) return 0;   // 원칙1
          if (rules.keepAcrossShift && info.idx === idx - 1 && info.period !== P) return 1;  // 원칙2
          if (rules.keepAfterOff && info.idx < idx - 1) return 2;                            // 원칙3
          return -1;
        };
        // 자리 점수 — 사전식: 앉는 사람 수(등급별) > 원칙1 겹침 합 > 원칙2 겹침 합 > 원칙3 겹침 합
        // > 최근에 본 사람 > 선임. 등급이 자리뿐 아니라 **방 선택**에서도 앞선다: 예전엔 겹침을
        // 등급 없이 합쳐서, 오프 복귀자가 4칸 겹치는 방을 잡으려고 전일 근무자를 2칸짜리 방으로
        // 밀어내는(5~10 보던 사람이 6~9 대신 5,10,11) 일이 있었다. 자릿수는 2^53 안에 들도록
        // 잡았다: 한 사람 겹침 ≤99, 자리마다 병실이 갈리므로 여럿의 겹침 합은 병동 병상 수(<500)를 넘지
        // 않는다 → 원칙1 겹침 합 ×2e10 < 원칙3 자리 하나(1e13). 자리 합도 짝 ≤6 × 1e15 + … < 2^53(≈9.007e15).
        const SEAT_W = [1e15, 1e14, 1e13], OV_W = [2e10, 4e7, 8e4];
        // 누가 잇는지 — 최근(며칠 전에 봤나, 하루 단위로 100일까지) → 선임. (b) 라벨 폴백의 순서와 같다.
        //  예전엔 날짜 번호를 8일씩 묶어 '4일 전·5일 전'이 묶음 경계에 따라 같거나 달랐다 (2026-10-01 교차 검토)
        const tieOf = function (n, info) {
          const recency = 101 - Math.max(1, Math.min(101, idx - info.idx));                  // 0~100
          return recency * 100 + Math.max(0, 99 - n.seniority);                             // ≤ 10099
        };
        // 한 시간대 안에서는 기록·방이 그대로라 사람×자리 값은 한 번만 센다 (CRN 자리를 고를 때 같은 값을 여러 번 묻는다)
        const cached = function (f) {
          const memo = {};
          return function (n, l) {
            const row = memo[n.id] || (memo[n.id] = {});
            return l in row ? row[l] : (row[l] = f(n, l));
          };
        };
        // 방 기준 점수 — 전에 본 병실과 이 자리 병실이 겹칠 때만 (0 = 이어지는 것이 없음)
        const roomW = cached(function (n, l) {
          const info = lastSeen[n.id];
          if (!roomsFor || !info || !avOk(n.id, l)) return 0;
          const t = tierOf(info);
          if (t < 0) return 0;
          const o = Math.min(99, overlap(info.rooms, roomsByLabel[l], bedsOf));
          if (!o) return 0;
          return SEAT_W[t] + o * OV_W[t] + tieOf(n, info);
        });
        // 라벨 기준 점수 — (b) 라벨 유지 폴백과 같은 판단 (방 정보로 못 이을 때 같은 자리 이름)
        const labelW = function (n, l) {
          const info = lastSeen[n.id];
          if (!info || info.label !== l || !avOk(n.id, l)) return 0;
          const t = tierOf(info);
          return t < 0 ? 0 : SEAT_W[t] + tieOf(n, info);
        };
        // 이어 보는 몫 — 연속성은 자리 이름이 아니라 병실이다: 방을 아는 사람은 방 겹침만, 같은 자리 이름은 방을 모르는 사람만.
        // (방을 아는 사람에게 같은 이름 점수를 주면 방이 옮겨 가 겹침이 0 인 자리에도 원칙 점수가 통째로 붙는다.)
        const knowsRooms = function (info) { return !!(roomsFor && info && info.rooms && info.rooms.length); };
        const seatV = cached(function (n, l) {
          return knowsRooms(lastSeen[n.id]) && roomsByLabel[l] && roomsByLabel[l].length ? roomW(n, l) : labelW(n, l);
        });
        // 원칙4 — 쉬고 온 사람이 이 자리에 앉으면 전에 보던 방을 다시 보는가 (꺼져 있으면 늘 아니다)
        const bounceHit = cached(function (n, l) {
          if (!rules.bounceAfterOff) return false;
          const info = lastSeen[n.id];
          if (!info || !(info.idx < idx - 1)) return false;
          if (roomsFor && info.rooms && info.rooms.length && roomsByLabel[l] && roomsByLabel[l].length)
            return overlap(info.rooms, roomsByLabel[l]) > 0;
          return info.label === l;
        });
        // 헬퍼 — 자리보다 사람이 많으면 후임이 헬퍼다. 선임이 헬퍼가 될수록 큰 값(2의 거듭제곱 합 = 선임부터 사전식)
        const senRank = {};
        staff.slice().sort(function (a, b) { return a.seniority - b.seniority; })
          .forEach(function (n, i) { senRank[n.id] = i; });
        const helperPen = function (id) { return Math.pow(2, Math.max(0, Math.min(52, staff.length - 1 - senRank[id]))); };

        // 이어 보는 몫을 둘로 — 원칙 점수(등급별 사람 수·겹친 병상)와 같을 때 누가 잇는지 정하는 몫(최근 → 선임).
        // 원칙 4 는 원칙 점수 다음, 이 몫보다 앞이다 (같은 점수에서 '선임이 이어 본다'가 튕기기를 이기지 않게)
        const seatTie = cached(function (n, l) { return seatV(n, l) > 0 ? tieOf(n, lastSeen[n.id]) : 0; });

        // 3) 다듬기 — 손으로 고정한 자리·차지를 뺀 자리 전부를 따져 보고 가장 나은 배치로 (자리 ≤6 이라 비트마스크로 정확히).
        //  비용(작을수록 좋다, 사전식): 주지 않을 방 > 같은 그룹 인계(병상) > -원칙 점수 > 헬퍼 선임 > 튕김 > -누가 잇는지 > 위 단계 배치에서 옮긴 사람 수.
        //  뒤 셋은 한 수로 싼다: 튕김×1e8 + (-누가 잇는지)×100 + 옮김 — 누가 잇는지 ≤ 6×10099, 옮김 ≤ 99 라 자리가 섞이지 않는다
        // 위 단계가 이미 가장 나은 날은 건너뛴다(속도 — 400일 × 시간대마다 돈다). 위 단계가 놓칠 수 있는 것은 넷뿐이다:
        //  주지 않을 방 · 원칙 4 · 헬퍼(자리보다 사람이 많은 날) · 방 매칭이 못 보는 것(방을 모르는 기록, 방 구성이 빈 자리).
        //  나머지는 방 매칭(정확한 최적)과 남은 자리 선임 순이 이미 같은 답을 낸다 — scripts/test_assign_principles.mjs 가 지킨다.
        //  그룹 인계도 위 단계는 보지 않으므로 넘겨받을 병상이 하나라도 있으면 다듬는다
        const needPolish = (function () {
          if (rules.bounceAfterOff || staff.length > labels.length) return true;
          if (holders) for (let i = 0; i < staff.length; i++)
            for (let j = 0; j < labels.length; j++) if (handW(staff[i], labels[j])) return true;
          for (let i = 0; i < staff.length; i++) if ((av[staff[i].id] || []).length) return true;
          if (!roomsFor) return false;
          for (let i = 0; i < labels.length; i++) if (!roomsByLabel[labels[i]].length) return true;
          for (let i = 0; i < staff.length; i++) {
            const info = lastSeen[staff[i].id];
            if (info && tierOf(info) >= 0 && !knowsRooms(info)) return true;
          }
          return false;
        })();
        const polish = function (assigned, rest, chargeId) {
          if (!needPolish) return rest;
          const seats = labels.filter(function (l) {
            return assigned[l] && !ovIds[assigned[l].id] && assigned[l].id !== chargeId;
          });
          if (!seats.length) return rest;
          const people = seats.map(function (l) { return assigned[l]; }).concat(rest);
          const was = {};
          for (let j = 0; j < seats.length; j++) was[assigned[seats[j]].id] = seats[j];
          const nS = seats.length, full = 1 << nS;
          let V = new Float64Array(full), G = new Float64Array(full), C = new Float64Array(full), H = new Float64Array(full), L = new Float64Array(full);
          let V2 = new Float64Array(full), G2 = new Float64Array(full), C2 = new Float64Array(full), H2 = new Float64Array(full), L2 = new Float64Array(full);
          V.fill(Infinity); V[0] = 0;
          const sv = new Float64Array(nS), sg = new Float64Array(nS), sc = new Float64Array(nS), sl = new Float64Array(nS);
          // (v,g,c,h,l) 가 상태 k 보다 작으면 — 같으면 먼저 찾은 것을 둔다
          const beats = function (k, v, g, c, h, l) {
            if (V2[k] === Infinity || v !== V2[k]) return v < V2[k];
            if (g !== G2[k]) return g < G2[k];
            if (c !== C2[k]) return c < C2[k];
            if (h !== H2[k]) return h < H2[k];
            return l < L2[k];
          };
          const back = [];
          for (let i = 0; i < people.length; i++) {
            const n = people[i];
            for (let j = 0; j < nS; j++) {
              const l = seats[j], v = seatV(n, l), t = seatTie(n, l);
              sv[j] = avOk(n.id, l) ? 0 : 1; sg[j] = handW(n, l); sc[j] = t - v;
              sl[j] = (bounceHit(n, l) ? 1e8 : 0) - t * 100 + (was[n.id] === l ? 0 : 1);
            }
            const hp = helperPen(n.id), hl = was[n.id] ? 1 : 0;   // 헬퍼로
            V2.fill(Infinity);
            const bk = new Int8Array(full).fill(-2);
            for (let m = 0; m < full; m++) {
              const v0 = V[m];
              if (v0 === Infinity) continue;
              const g0 = G[m], c0 = C[m], h0 = H[m], l0 = L[m];
              let h = h0 + hp, l = l0 + hl;
              if (beats(m, v0, g0, c0, h, l)) {
                V2[m] = v0; G2[m] = g0; C2[m] = c0; H2[m] = h; L2[m] = l; bk[m] = -1;
              }
              for (let j = 0; j < nS; j++) {
                if (m & (1 << j)) continue;
                const k = m | (1 << j), v = v0 + sv[j], g = g0 + sg[j], c = c0 + sc[j];
                l = l0 + sl[j];
                if (beats(k, v, g, c, h0, l)) {
                  V2[k] = v; G2[k] = g; C2[k] = c; H2[k] = h0; L2[k] = l; bk[k] = j;
                }
              }
            }
            let t;
            t = V; V = V2; V2 = t; t = G; G = G2; G2 = t; t = C; C = C2; C2 = t; t = H; H = H2; H2 = t; t = L; L = L2; L2 = t;
            back.push(bk);
          }
          const f = full - 1;
          if (V[f] === Infinity) return rest;
          // 고른 배치가 위 단계 배치와 같으면(옮김이 마지막 기준이라 더 나은 것이 없을 때) 그대로
          let mask = f;
          const out = [];
          let moved = false;
          const pickN = [];
          for (let i = people.length - 1; i >= 0; i--) {
            const j = back[i][mask];
            pickN[i] = j;
            if (j >= 0) { mask ^= (1 << j); if (was[people[i].id] !== seats[j]) moved = true; }
            else if (was[people[i].id]) moved = true;
          }
          if (!moved) return rest;
          for (let i = 0; i < people.length; i++) {
            if (pickN[i] >= 0) assigned[seats[pickN[i]]] = people[i];
            else out.push(people[i]);
          }
          // 헬퍼는 선임 순으로 (위 단계와 같은 순서)
          return out.sort(function (a, b) { return a.seniority - b.seniority; });
        };

        // 2~4) 나머지 자리 — (a) 방 매칭 → (b) 라벨 폴백 → 잔여(선임 순) → 회피 복구. 함수로 둔 까닭은 아래 1)의
        //  방이 고정이 아닌 차지(102 CRN): 앉을 수 있는 자리마다 이 과정을 **그대로 돌려 보고** 고른다.
        const place = function (assigned, taken, chargeId) {
          const freeLabels = function () {
            return labels.filter(function (l) { return !assigned[l]; });
          };
          // 연속성 — 원칙 우선순위(1 > 2 > 3)는 그대로, 자리 배치만 함께 푼다
          const cand = staff.filter(function (n) {
            return !taken[n.id] && lastSeen[n.id] && tierOf(lastSeen[n.id]) >= 0;
          });

          // (a) 방 기준 매칭 — 세 원칙을 한 번에 푼다.
          //     점수는 계층이 절대 우선(원칙1을 한 명이라도 더 앉히는 쪽이 언제나 이김),
          //     그 다음 겹친 병실 수, 동점이면 최근에 본 사람 → 선임 순.
          //     한 번에 푸는 이유: 원칙1인 사람이 두 자리에 무차별할 때(양쪽 겹침 동일)
          //     오프 복귀자가 원래 보던 방을 되찾도록 자리를 비켜 줄 수 있다.
          if (roomsFor && cand.length) {
            const free = freeLabels().filter(function (l) { return roomsByLabel[l].length; });
            if (free.length) {
              const W = cand.map(function (n) {
                return free.map(function (l) { return roomW(n, l); });
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
                return tieOf(b.n, b.info) - tieOf(a.n, a.info);   // 최근 → 선임 (다듬기·방 매칭과 같은 몫)
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
            const bounceOk = function (n) { return !bounceHit(n, rem[i]); };
            // 회피 라벨(금지 방)과 원칙4 둘 다 통과 → 회피만 통과 → 아무나 (미충원 방지)
            let pick = leftover.findIndex(function (n) { return avOk(n.id, rem[i]) && bounceOk(n); });
            if (pick < 0) pick = leftover.findIndex(function (n) { return avOk(n.id, rem[i]); });
            if (pick < 0) pick = 0;
            const n = leftover.splice(pick, 1)[0];
            assigned[rem[i]] = n; taken[n.id] = true;
          }
          // 자리보다 사람이 많으면(보통 6인 이상): 라벨 소진 후 잔여 인원은 어싸인 없음(헬퍼)
          // 3) 다듬기 — 주지 않을 방·원칙4 를 위 단계가 놓친 것까지 (손으로 고정한 자리·차지는 건드리지 않는다.
          //  방이 고정이 아닌 차지도 — 그 자리는 이 다듬기까지 돌려 보고 고른 것이다)
          return polish(assigned, leftover, chargeId).map(function (n) { return n.id; });
        };

        // 1) 차지: DC/EC/NC 표시자 → 차지가능 최선임 → 최선임. 표시자가 둘 이상이면 그중 선임(명부 배열 순서가 아니라)
        const bySen = function (a, b) { return a.seniority - b.seniority; };
        const marked = function (n) { return CHARGE_CODES[(schedule[n.id] || {})[dk]]; };
        const floatSeats = opts.chargeSeats ? opts.chargeSeats(P, cnt, dk) : null;
        let chargeId = null, extra = null;
        if (floatSeats && floatSeats.length) {
          // 방이 고정이 아닌 차지 — 사람은 자리와 상관없이 고른다(손으로 자리를 옮긴 사람도 차지일 수 있다)
          let c = staff.filter(marked).sort(bySen)[0];
          if (!c) {
            const pool = staff.filter(function (n) { return chargeOk(n, P); });
            c = (pool.length ? pool : staff).slice().sort(bySen)[0];
          }
          chargeId = c.id;
          if (!taken[c.id]) {
            // 앉을 자리 — 허락된 빈 자리마다 차지를 앉혀 놓고 나머지 배정(place)을 **실제로** 돌려 본다. 그중
            //  ① 금지 방(회피)에 앉는 사람이 가장 적고 ② 이어 보는 병실이 가장 많은(차지 자신 포함, 원칙 등급이 먼저) 자리.
            // 예전엔 나머지가 이어 볼 몫을 따로 흉내 내 셌는데, 흉내가 실제 배정과 어긋나는 곳(금지 방·회피 복구·라벨 다툼)마다
            // CRN 이 남의 방을 가져가거나 금지 방을 남에게 떠넘겼다 (2026-10-01 교차 검토). 자리는 많아야 6개라 여섯 번 돌려도 싸다.
            // 앉을 수 있는 자리는 전부 돌려 본다 — CRN 이 제 금지 방만 먼저 피하면 그 방을 남이 떠안아 이어 보기만 잃는 날이 있다
            // (금지 방에 앉는 사람 수가 같으면 이어 보기가 많은 쪽이다. 2026-10-01 검증)
            const seatL = floatSeats.filter(function (l) { return labels.indexOf(l) >= 0 && !assigned[l]; });
            if (seatL.length) {
              const trial = function (l0) {
                const a = Object.assign({}, assigned), t = Object.assign({}, taken);
                if (l0) { a[l0] = c; t[c.id] = true; }
                const ex = place(a, t, l0 ? c.id : null);
                let viol = 0, g = 0, v = 0, ti = 0, bo = 0, hp = 0;
                for (const l in a) {
                  if (!ovIds[a[l].id] && !avOk(a[l].id, l)) viol++;
                  g += handW(a[l], l);
                  const w = seatTie(a[l], l);
                  v += seatV(a[l], l) - w; ti += w;
                  if (bounceHit(a[l], l)) bo++;
                }
                for (let i = 0; i < ex.length; i++) hp += helperPen(ex[i]);
                return { l: l0, a: a, t: t, ex: ex, viol: viol, g: g, v: v, ti: ti, bo: bo, hp: hp };
              };
              // 원칙 점수가 같으면: 헬퍼는 후임 — 그다음 원칙4(튕기기, 켰을 때만) — CRN 도 다른 사람도 쉬고 와서 전에 보던 방을
              // 다시 보는 사람이 적은 자리(남을 밀어내면서까지는 아니다) — 그다음 같은 점수에서 누가 잇는지(최근 → 선임).
              // 그다음 어제와 같은 자리 이름 — 방이 다 바뀌어 아무도 이어 보지 못하는 날 CRN 이 이유 없이 첫 자리로 가지 않게.
              // 그다음 **차지가 아닐 때 앉았을 자리** — 이어 볼 것이 없는 날(첫날·[CRN 맡기기]) CRN 이 첫 자리로 가 모두를
              // 한 칸씩 밀지 않게. /CRN 은 사람에 붙는다: CRN 을 바꿔도 자리는 그대로다.
              const cInfo = lastSeen[c.id];
              const sameL = function (l) { return !!(cInfo && cInfo.label === l && tierOf(cInfo) >= 0); };
              const nat = trial(null);
              let natL = null;
              for (const l in nat.a) if (nat.a[l] === c) natL = l;
              // 정수 합(< 2^53)이라 같음 비교가 정확하다 — 사전식으로
              // (금지 방, 같은 그룹 인계, 원칙 점수, 헬퍼, 튕김, 누가 잇는지, 같은 자리 이름, 차지가 아닐 때 자리)
              const better = function (r, b) {
                if (r.viol !== b.viol) return r.viol < b.viol;
                if (r.g !== b.g) return r.g < b.g;
                if (r.v !== b.v) return r.v > b.v;
                if (r.hp !== b.hp) return r.hp < b.hp;
                if (r.bo !== b.bo) return r.bo < b.bo;
                if (r.ti !== b.ti) return r.ti > b.ti;
                if (r.sl !== b.sl) return r.sl;
                return r.nat && !b.nat;
              };
              let best = null;
              // 차지가 아닐 때 앉았을 자리가 허락된 자리면 그 배치 그대로 — **누가 CRN 이든 자리는 같다**(/CRN 은 사람에 붙는다).
              // 그 배치는 차지를 빼고 짠 가장 나은 배치라 허락된 자리 중에서도 가장 낫다. 예전엔 점수가 같은 자리가 여럿이면
              // CRN 의 '어제 같은 자리 이름'을 먼저 따져서, CRN 을 바꾸면 두 사람이 맞바뀌고 다음 날까지 이어졌다 (2026-10-01 실시간 수정 검사)
              // (빈 허락 자리가 하나뿐이어도 먼저 본다 — 그 자리에 바로 앉히고 나머지를 짜면 점수가 같은 배치 중 다른 것이 나올 수 있다)
              if (natL && seatL.indexOf(natL) >= 0) best = nat;
              // 차지가 아니면 종이 밖 자리(양식 줄을 넘는 자리·헬퍼)였을 사람 — 허락된 자리마다 돌려 보고 고른다
              else for (let s = 0; s < seatL.length; s++) {
                const r = trial(seatL[s]);
                r.sl = sameL(r.l); r.nat = r.l === natL;
                if (!best || better(r, best)) best = r;
              }
              for (const l in best.a) assigned[l] = best.a[l];
              for (const id in best.t) taken[id] = best.t[id];
              extra = best.ex;
            }
          }
        } else {
          if (!assigned['차지']) {
            let c = staff.filter(function (n) { return !taken[n.id] && marked(n); }).sort(bySen)[0];
            if (!c) {
              // 주지 않을 방과 상관없이 시니어리티로 — 차지 방에 주지 않을 방이 걸려도 차지는 그대로(경고로 알린다)
              const pool = staff.filter(function (n) { return !taken[n.id] && chargeOk(n, P); });
              const base = pool.length ? pool : staff.filter(function (n) { return !taken[n.id]; });
              c = base.slice().sort(bySen)[0];
            }
            if (c) { assigned['차지'] = c; taken[c.id] = true; }
          }
          if (assigned['차지']) chargeId = assigned['차지'].id;
        }
        // 차지가 자리에 안 묶이는데 허락된 자리가 다 손으로 찼으면 차지도 보통 간호사처럼 다듬기에서 옮겨 앉힌다 —
        // 차지를 다듬기에서 빼면 앞 단계가 앉힌 자리에 굳어 남이 주지 않을 방을 떠안았다 (2026-10-01 교차 검토)
        if (!extra) extra = place(assigned, taken, floatSeats && floatSeats.length ? null : chargeId);

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
        if (chargeId && byNurse[chargeId] && byNurse[chargeId][dk]) byNurse[chargeId][dk].charge = true;
        const out = { labels: labelMap, extra: extra, charge: chargeId };
        // 피하지 못한 같은 그룹 인계 — 받은 사람·준 사람마다 병상 토큰
        if (holders) {
          const hv = [];
          for (const l in assigned) {
            const n = assigned[l];
            if (!hGroups[n.id]) continue;
            const by = {};
            const rs = roomsByLabel[l] || [];
            for (let i = 0; i < rs.length; i++)
              (holders[rs[i]] || []).forEach(function (h) { if (sameGroup(h, n.id)) (by[h] = by[h] || []).push(rs[i]); });
            for (const h in by) hv.push({ from: h, to: n.id, rooms: by[h] });
          }
          if (hv.length) out.handover = hv;
        }
        (byDay[dk] = byDay[dk] || {})[P] = out;
        // 다음 근무의 '앞 근무' — 자리에 앉은 사람만 병상을 본다(헬퍼는 넘길 병상이 없다)
        if (hOn) {
          const hs = {};
          for (const l in assigned) {
            const rs = roomsByLabel[l] || [];
            for (let i = 0; i < rs.length; i++) (hs[rs[i]] = hs[rs[i]] || []).push(assigned[l].id);
          }
          prevShift = { idx: idx, P: P, holders: hs };
        }
      }
    }
    return { byDay: byDay, byNurse: byNurse };
  }

  const api = { compute: compute, periodOf: periodOf, LABELS: LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AssignCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
