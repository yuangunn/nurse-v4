# 어싸인 배정표 사용설명서

병동에 나눠 줄 인쇄용 설명서. **A4 18쪽**, 화면 캡처는 전부 `standalone/assign.html` 을
예시 데이터(홍길동·김영숙 등 12명, 2026-09-13 주)로 실제로 띄워 찍은 것이다.

| 파일 | 내용 |
|---|---|
| `어싸인_배정표_사용설명서.pdf` | 배포물. 그대로 인쇄하거나 메일에 첨부한다 |
| `manual.html` | 설명서 원본. 글자·차례를 고칠 곳 |
| `shots.mjs` | 캡처 생성 — `standalone/assign.html` 을 띄워 `shots/*.png` 를 만든다 |
| `build.mjs` | 검사 + PDF 출력 |

`shots/` 는 커밋하지 않는다 (PDF 안에 이미 들어 있고, 언제든 다시 찍을 수 있다).

## 다시 만들기

```bash
npm i playwright-core            # 리포 루트에 없으면
node docs/manual/shots.mjs       # 그림 다시 찍기 (화면이 바뀌었을 때만)
node docs/manual/build.mjs       # 검사 + PDF
```

`build.mjs` 는 쪽마다 **내용이 넘치는지 · 쪽 번호와 겹치는지**를 먼저 보고
걸리면 PDF 를 쓰지 않고 그 쪽 번호를 알려 준다. 캡처가 커서 걸릴 때는
그 `<figure>` 의 `<img style="max-height:…">` 를 줄인다.

`PW_CHROMIUM` 으로 크로미움 경로를 줄 수 있다.

## 고칠 때

- 글씨는 **화면 그대로**. 버튼 이름을 설명서에서 의역하면 사용자가 못 찾는다.
- 한 쪽 = `<section class="pg">` 하나. 쪽을 넘기지 말고 쪽을 새로 만든다.
- 서체는 `frontend/fonts/PretendardVariable.woff2` 를 상대 경로로 읽는다 —
  PDF 로 뽑을 때 크로미움이 쓴 글자만 파일 안에 넣으므로 받는 쪽에 서체가 없어도 된다.
- 화면을 바꿨으면 `shots.mjs` 부터 다시 돌린다. 캡처가 옛 화면이면 설명서가 거짓말이 된다.
