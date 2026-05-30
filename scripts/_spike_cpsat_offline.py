"""ortools가 (인터넷 없이) 임포트·풀이 되는지 최소 확인. — Phase 0 게이트 보조.

dev python에서: py scripts/_spike_cpsat_offline.py  → "CPSAT_OK 2"
번들 검증은 /api/dev/cpsat-selftest 엔드포인트로 (동일 로직).
"""
from ortools.sat.python import cp_model


def cpsat_selftest() -> int:
    """5개 부울 중 정확히 2개를 1로 — feasible 해의 합(=2)을 반환."""
    m = cp_model.CpModel()
    xs = [m.NewBoolVar(f"x{i}") for i in range(5)]
    m.Add(sum(xs) == 2)
    s = cp_model.CpSolver()
    st = s.Solve(m)
    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError(f"CP-SAT self-test infeasible: status={st}")
    return sum(int(s.Value(x)) for x in xs)


if __name__ == "__main__":
    print("CPSAT_OK", cpsat_selftest())
