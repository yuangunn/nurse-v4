Attribute VB_Name = "어싸인배정"
Option Explicit
' ════════════════════════════════════════════════════════════════════
' 어싸인 자동 배정 — Excel VBA 단독 실행 버전 (인트라넷용)
'
' 설치: Alt+F11 → 파일 > 파일 가져오기 → 이 .bas 파일
'
' 매크로 3개 (Alt+F8):
'   1. 초기세팅생성  — "설정" 시트 생성 (간호사·가능근무·필요인원·방·원칙)
'   2. 근무표생성    — 선택한 년월의 빈 근무표 시트 + [어싸인 배정] 버튼 생성
'   3. 어싸인배정실행 — 근무표를 읽어 어싸인/어싸인상세 시트 생성 (버튼이 호출)
'
' 근무표 입력법:
'   D, E, N          일반 근무
'   DC, EC, NC       차지 근무 (그 사람이 차지방)
'   D/A, E/B, N/C    어싸인 선입력 — 근무 + 방 라벨 고정 (하루만 적어도
'                    이후 날짜는 원칙 1~3으로 이어서 자동 배정됨)
'   그 외 (OF, 주, V, 중, D1 등) — 어싸인 배정 제외
'
' 배정 원칙 (설정 시트에서 O/X로 on/off):
'   차지: DC/EC/NC 표시자 우선, 없으면 차지가능(설정) 최선임 (항상 적용)
'   1. 전일 같은 근무 → 봤던 방 유지 (최우선)
'   2. 전일 다른 근무 → 봤던 방 유지
'   3. 오프 복귀자 → 봤던 방 유지
'   4. 오프 복귀자 튕기기 — 복귀 시 이전 방 제외 (원칙3과 동시 O 불가)
' ════════════════════════════════════════════════════════════════════

Private Const MAX_LABELS As Long = 5
Private Const UI_FONT As String = "맑은 고딕"   ' 공통 서식 폰트 (모듈 선언은 반드시 프로시저 앞)

' Alt+F8 매크로 목록용 진입점 — 파라미터(Optional 포함) 있는 Sub는 목록에 안 보이므로
' 사용자용 매크로 3개는 반드시 파라미터 없이 유지할 것
Public Sub 초기세팅생성(): 초기세팅_코어 False: End Sub
Public Sub 근무표생성(): 근무표_코어 0, 0, False: End Sub
Public Sub 어싸인배정실행(): 어싸인_코어 False: End Sub

' 자동화 진입점(대화상자 없이 실행) — 스크립트/AppleScript run VB macro 용
Public Sub 자동_초기세팅(): 초기세팅_코어 True: End Sub
Public Sub 자동_근무표(ByVal 연 As Long, ByVal 월 As Long): 근무표_코어 연, 월, True: End Sub
Public Sub 자동_어싸인(): 어싸인_코어 True: End Sub

' 설정 시트 버튼용 — 가장 최근 근무표_* 시트를 찾아 어싸인 실행
Public Sub 어싸인배정_최신()
    Dim ws As Worksheet, best As Worksheet
    For Each ws In ThisWorkbook.Worksheets
        If Left(ws.Name, 4) = "근무표_" Then
            If best Is Nothing Then
                Set best = ws
            ElseIf ws.Name > best.Name Then   ' 근무표_YYYY-MM 문자열 정렬 = 최신
                Set best = ws
            End If
        End If
    Next ws
    If best Is Nothing Then
        MsgBox "근무표 시트가 없습니다. [근무표 생성] 버튼을 먼저 실행하세요.", vbExclamation
        Exit Sub
    End If
    best.Activate
    어싸인_코어 False
End Sub

' ══════════════════════════════════════════════════════════════
' 공통 서식 헬퍼 (깔끔·심플·사무용)
' ══════════════════════════════════════════════════════════════
Private Sub SheetBase(ws As Worksheet)
    ws.Cells.Font.Name = UI_FONT
    ws.Cells.Font.Size = 10
    ws.Activate
    On Error Resume Next
    ActiveWindow.DisplayGridlines = False
    On Error GoTo 0
End Sub

Private Sub TitleStyle(c As Range, ByVal sz As Long)
    c.Font.Bold = True: c.Font.Size = sz: c.Font.Color = RGB(46, 56, 77)
End Sub

Private Sub SectionHead(c As Range)
    c.Font.Bold = True: c.Font.Size = 11: c.Font.Color = RGB(46, 56, 77)
    BottomRule c
End Sub

Private Sub MuteStyle(c As Range)
    c.Font.Size = 9: c.Font.Color = RGB(130, 134, 148)
End Sub

Private Sub HeadStyle(rng As Range)
    rng.Interior.Color = RGB(237, 240, 245)
    rng.Font.Bold = True: rng.Font.Color = RGB(55, 62, 80)
    rng.HorizontalAlignment = xlCenter: rng.VerticalAlignment = xlCenter
End Sub

Private Sub BoxBorders(rng As Range)
    With rng.Borders
        .LineStyle = xlContinuous: .Color = RGB(214, 218, 226): .Weight = xlThin
    End With
End Sub

Private Sub BottomRule(rng As Range)
    With rng.Borders(xlEdgeBottom)
        .LineStyle = xlContinuous: .Color = RGB(150, 158, 172): .Weight = xlMedium
    End With
End Sub

' ══════════════════════════════════════════════════════════════
' 매크로 1: 초기세팅 시트 생성
' ══════════════════════════════════════════════════════════════
Private Sub 초기세팅_코어(Optional 조용히 As Boolean = False)
    If SheetExists("설정") And Not 조용히 Then
        If MsgBox("""설정"" 시트가 이미 있습니다. 초기화할까요? (기존 세팅 삭제)", _
                  vbYesNo + vbExclamation) <> vbYes Then Exit Sub
    End If
    Dim ws As Worksheet: Set ws = GetCleanSheet("설정")
    Application.ScreenUpdating = False

    ws.Range("A1").Value = "어싸인 자동 배정 — 초기 설정"
    ws.Range("A1").Font.Bold = True: ws.Range("A1").Font.Size = 14

    ' ── 간호사 목록 (A열 블록, 아래로 자유롭게 추가) ──
    ws.Range("A3").Value = "■ 간호사 목록  (위 = 선임 · O 표시 = 해당 근무 가능 · DC/EC/NC에 O = 차지 가능)"
    ws.Range("A3").Font.Bold = True
    Dim hdr As Variant: hdr = Array("이름", "DC", "D", "EC", "E", "NC", "N", "비고")
    Dim c As Long
    For c = 0 To UBound(hdr): ws.Cells(4, c + 1).Value = hdr(c): Next c
    ws.Range("A4:H4").Font.Bold = True
    ws.Range("A4:H4").Interior.Color = RGB(240, 240, 245)
    ' 예시 18명 (이름을 실제로 바꿔 쓰세요 · 위 = 선임 · 상위 6명 = 차지 가능 예시)
    Dim ex As Long
    For ex = 1 To 18
        ws.Cells(4 + ex, 1).Value = "예시)간호" & Format(ex, "00")
        If ex <= 6 Then
            ws.Range(ws.Cells(4 + ex, 2), ws.Cells(4 + ex, 7)).Value = "O"   ' DC D EC E NC N
        Else
            ws.Cells(4 + ex, 3).Value = "O"   ' D
            ws.Cells(4 + ex, 5).Value = "O"   ' E
            ws.Cells(4 + ex, 7).Value = "O"   ' N
        End If
    Next ex

    ' ── 배정 원칙 (J열 블록) ──
    ws.Range("J3").Value = "■ 배정 원칙 (O = 사용)": ws.Range("J3").Font.Bold = True
    ws.Range("J4").Value = "원칙1 — 전일 같은 근무면 방 유지": ws.Range("K4").Value = "O"
    ws.Range("J5").Value = "원칙2 — 근무 바뀌어도 방 유지": ws.Range("K5").Value = "O"
    ws.Range("J6").Value = "원칙3 — 오프 복귀자 방 유지": ws.Range("K6").Value = "O"
    ws.Range("J7").Value = "원칙4 — 오프 복귀자 튕기기": ws.Range("K7").Value = "X"
    ws.Range("J8").Value = "※ 원칙3·4는 반대 개념 — 동시에 O 금지 (동시 O면 원칙3만 적용되고 배정 시 경고)"

    ' ── 요일별 필요인원 ──
    ws.Range("J10").Value = "■ 요일별 필요인원 (근무표 생성 시 기본값 — 근무표 하단에서 일별 수정 가능)"
    ws.Range("J10").Font.Bold = True
    Dim wdHdr As Variant: wdHdr = Array("구분", "월", "화", "수", "목", "금", "토", "일")
    For c = 0 To 7: ws.Cells(11, 10 + c).Value = wdHdr(c): Next c
    ws.Range("J11:Q11").Font.Bold = True: ws.Range("J11:Q11").Interior.Color = RGB(240, 240, 245)
    ws.Range("J12").Value = "D": ws.Range("K12:Q12").Value = Array(4, 5, 5, 5, 5, 3, 3)
    ws.Range("J13").Value = "E": ws.Range("K13:Q13").Value = Array(5, 5, 5, 5, 4, 3, 4)
    ws.Range("J14").Value = "N": ws.Range("K14:Q14").Value = Array(3, 3, 3, 3, 3, 2, 3)

    ' ── 방 목록 ──
    ws.Range("J16").Value = "■ 방 목록": ws.Range("J16").Font.Bold = True
    ws.Range("J17").Value = "방번호": ws.Range("K17").Value = "유형"
    ws.Range("J17:K17").Font.Bold = True: ws.Range("J17:K17").Interior.Color = RGB(240, 240, 245)
    Dim rooms As Variant, types As Variant, r As Long
    rooms = Array(1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1014)
    types = Array("5인실", "5인실", "5인실", "5인실", "5인실", "5인실", "2인실", "2인실", "1인실", "2인실", "2인실", "2인실", "5인실")
    For r = 0 To UBound(rooms)
        ws.Cells(18 + r, 10).Value = rooms(r)
        ws.Cells(18 + r, 11).Value = types(r)
    Next r

    ' ── 어싸인별 방 구성 ──
    ws.Range("J33").Value = "■ 어싸인별 방 구성 (근무 인원수별 · 방번호 쉼표 구분 · 2인 근무는 비워두면 수동 분배)"
    ws.Range("J33").Font.Bold = True
    ws.Range("J34").Value = "인원수": ws.Range("K34").Value = "어싸인": ws.Range("L34").Value = "방 목록"
    ws.Range("J34:L34").Font.Bold = True: ws.Range("J34:L34").Interior.Color = RGB(240, 240, 245)
    Dim sch As Variant
    sch = Array( _
        Array("5인", "차지", "1012, 1014"), Array("5인", "A", "1001, 1002"), _
        Array("5인", "B", "1003, 1004"), Array("5인", "C", "1005, 1010, 1011"), _
        Array("5인", "D", "1006, 1007, 1008, 1009"), _
        Array("4인", "차지", "1001, 1014"), Array("4인", "A", "1002, 1003, 1012"), _
        Array("4인", "B", "1004, 1005, 1011"), Array("4인", "C", "1006, 1007, 1008, 1009, 1010"), _
        Array("3인", "차지", "1001, 1012, 1014"), Array("3인", "A", "1002, 1003, 1004, 1011"), _
        Array("3인", "B", "1005, 1006, 1007, 1008, 1009, 1010"), _
        Array("2인", "차지", ""), Array("2인", "A", ""))
    For r = 0 To UBound(sch)
        ws.Cells(35 + r, 10).Value = sch(r)(0)
        ws.Cells(35 + r, 11).Value = sch(r)(1)
        ws.Cells(35 + r, 12).Value = sch(r)(2)
    Next r

    ' ── 사용법 (요일별 필요인원 표와 안 겹치게 S열로) ──
    ws.Range("S3").Value = "■ 사용법": ws.Range("S3").Font.Bold = True
    Dim guide As Variant
    guide = Array( _
        "1. 이 시트의 간호사 목록·방 구성 등을 병동에 맞게 수정", _
        "2. 위 [근무표 생성] 버튼 → 년·월 입력 → 빈 근무표 시트 생성", _
        "3. 근무표에 근무 입력:", _
        "   D E N = 일반 / DC EC NC = 차지 / OF 주 V 등 = 어싸인 제외", _
        "   선입력: D/A E/B N/C 식으로 쓰면 그 어싸인으로 고정되고", _
        "   이후 날짜는 원칙 1~3으로 이어서 자동 배정됩니다.", _
        "   (예: 1일 하루만 어싸인을 적으면 2일부터 자동)", _
        "4. 근무표 하단 필요인원 행에서 일별 인원 수정 가능", _
        "   (인원 행이 필요와 다르면 빨간색 표시)", _
        "5. 근무표 시트의 [어싸인 배정] 버튼 클릭", _
        "   → 어싸인_년-월 (그리드) / 어싸인상세_년-월 (일별 표) 생성", _
        "   굵은 글씨 = 선입력으로 고정된 칸", _
        "6. 선입력을 고치고 버튼을 다시 누르면 재배정됩니다.")
    For r = 0 To UBound(guide)
        ws.Cells(4 + r, 19).Value = guide(r)   ' S열 = 19
    Next r

    ws.Columns("A").ColumnWidth = 14
    ws.Columns("B:H").ColumnWidth = 5
    ws.Columns("J").ColumnWidth = 30
    ws.Columns("K").ColumnWidth = 14
    ws.Columns("L").ColumnWidth = 34
    ws.Columns("M:Q").ColumnWidth = 5     ' 요일별 필요인원 값 열
    ws.Columns("R").ColumnWidth = 3       ' 사용법과 간격
    ws.Columns("S").ColumnWidth = 62      ' 사용법

    ' ── 서식 (깔끔·사무용) ──
    SheetBase ws
    TitleStyle ws.Range("A1"), 14
    SectionHead ws.Range("A3")
    SectionHead ws.Range("J3")
    SectionHead ws.Range("J10")
    SectionHead ws.Range("J16")
    SectionHead ws.Range("J33")
    SectionHead ws.Range("S3")
    MuteStyle ws.Range("J8")   ' 원칙3·4 동시 O 금지 안내
    ' 간호사 표 (예시 18명 = 5~22행)
    HeadStyle ws.Range("A4:H4")
    BoxBorders ws.Range("A4:H22")
    ws.Range("A5:A22").HorizontalAlignment = xlLeft
    ws.Range("B5:H22").HorizontalAlignment = xlCenter
    ' 요일별 필요인원 표
    HeadStyle ws.Range("J11:Q11")
    BoxBorders ws.Range("J11:Q14")
    ws.Range("K12:Q14").HorizontalAlignment = xlCenter
    ' 방 목록 표
    HeadStyle ws.Range("J17:K17")
    BoxBorders ws.Range("J17:K30")
    ws.Range("K18:K30").HorizontalAlignment = xlCenter
    ' 어싸인별 방 구성 표
    HeadStyle ws.Range("J34:L34")
    BoxBorders ws.Range("J34:L48")
    ws.Range("J35:K48").HorizontalAlignment = xlCenter
    ' 원칙 O 표시 가운데
    ws.Range("K4:K7").HorizontalAlignment = xlCenter
    ws.Rows("1:48").RowHeight = 17
    ws.Range("A1").EntireRow.RowHeight = 22

    ' 실행 버튼 — Alt+F8 없이 시트에서 바로 (재생성 시 중복 방지 위해 삭제 후 추가)
    On Error Resume Next
    ws.Buttons.Delete
    On Error GoTo 0
    Dim b As Button
    Set b = ws.Buttons.Add(ws.Range("J1").Left, ws.Range("J1").Top + 2, 110, 24)
    b.OnAction = "근무표생성": b.Caption = "근무표 생성 →"
    Set b = ws.Buttons.Add(ws.Range("J1").Left + 118, ws.Range("J1").Top + 2, 130, 24)
    b.OnAction = "어싸인배정_최신": b.Caption = "어싸인 배정 (최근) →"

    Application.ScreenUpdating = True
    ws.Activate
    If Not 조용히 Then MsgBox "설정 시트를 만들었습니다." & vbLf & "간호사 목록을 수정한 뒤 [근무표 생성] 버튼을 누르세요.", vbInformation
End Sub

' ══════════════════════════════════════════════════════════════
' 매크로 2: 근무표 시트 생성
' ══════════════════════════════════════════════════════════════
Private Sub 근무표_코어(Optional 연 As Long = 0, Optional 월 As Long = 0, Optional 조용히 As Boolean = False)
    If Not SheetExists("설정") Then
        If Not 조용히 Then MsgBox "먼저 [초기세팅생성] 매크로를 실행해 설정 시트를 만드세요.", vbExclamation
        Exit Sub
    End If

    Dim y As Long, m As Long, defY As Long, defM As Long
    defM = Month(Now) + 1: defY = Year(Now)
    If defM > 12 Then defM = 1: defY = defY + 1
    Dim s As String
    If 연 > 0 And 월 > 0 Then
        y = 연: m = 월
    Else
        s = InputBox("년도를 입력하세요", "근무표 생성", defY)
        If s = "" Then Exit Sub
        y = Val(s)
        s = InputBox("월을 입력하세요 (1~12)", "근무표 생성", defM)
        If s = "" Then Exit Sub
        m = Val(s)
    End If
    If y < 2000 Or y > 2099 Or m < 1 Or m > 12 Then
        If Not 조용히 Then MsgBox "년/월이 올바르지 않습니다.", vbExclamation
        Exit Sub
    End If

    Dim ym As String: ym = y & "-" & Format(m, "00")
    Dim shName As String: shName = "근무표_" & ym
    If SheetExists(shName) Then
        If 조용히 Then
            Application.DisplayAlerts = False
            ThisWorkbook.Worksheets(shName).Delete
            Application.DisplayAlerts = True
        Else
            MsgBox """" & shName & """ 시트가 이미 있습니다. 해당 시트를 여세요." & vbLf & _
                   "(다시 만들려면 기존 시트를 먼저 삭제)", vbExclamation
            ThisWorkbook.Worksheets(shName).Activate: Exit Sub
        End If
    End If

    ' 설정에서 간호사 이름 읽기
    Dim names() As String, nN As Long
    nN = ReadNurseNames(names)
    If nN = 0 Then
        If Not 조용히 Then MsgBox "설정 시트에 간호사가 없습니다.", vbExclamation
        Exit Sub
    End If

    Application.ScreenUpdating = False
    Dim ws As Worksheet
    Set ws = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
    ws.Name = shName

    Dim nD As Long: nD = Day(DateSerial(y, m + 1, 0))
    Dim wdName As Variant: wdName = Array("월", "화", "수", "목", "금", "토", "일")

    ws.Range("A1").Value = y & "년 " & m & "월 근무표"
    ws.Range("A2").Value = "입력: D E N (일반) · DC EC NC (차지) · D/A E/B 식 = 어싸인 선입력(고정) · OF 주 V 등 = 어싸인 제외"

    ' 헤더 (3행 날짜, 4행 요일)
    ws.Cells(3, 1).Value = "이름"
    Dim d As Long, wd As Long
    For d = 1 To nD
        ws.Cells(3, 1 + d).Value = d
        wd = Weekday(DateSerial(y, m, d), vbMonday)
        ws.Cells(4, 1 + d).Value = wdName(wd - 1)
        If wd = 6 Then ws.Cells(4, 1 + d).Font.Color = RGB(30, 90, 200)
        If wd = 7 Then ws.Cells(4, 1 + d).Font.Color = RGB(200, 40, 40)
    Next d
    With ws.Range(ws.Cells(3, 1), ws.Cells(4, 1 + nD))
        .Font.Bold = True
        .Interior.Color = RGB(237, 240, 245)
        .HorizontalAlignment = xlCenter
        .VerticalAlignment = xlCenter
    End With
    ws.Cells(3, 1).HorizontalAlignment = xlLeft
    BottomRule ws.Range(ws.Cells(4, 1), ws.Cells(4, 1 + nD))

    ' 간호사 행
    Dim i As Long
    For i = 1 To nN
        ws.Cells(4 + i, 1).Value = names(i)
    Next i

    ' 하단: 인원 카운트(수식) + 필요인원(요일 기본값, 편집 가능)
    Dim base As Long: base = 4 + nN + 1  ' 한 줄 띄움
    Dim req As Variant: req = ReadWeekdayReq()  ' req(1..3 D/E/N, 1..7 월~일)
    Dim pLabel As Variant: pLabel = Array("D", "E", "N")
    Dim p As Long, rowCnt As Long, rowReq As Long
    Dim colL As String, rng As String
    For p = 0 To 2
        rowCnt = base + p * 2
        rowReq = base + p * 2 + 1
        ws.Cells(rowCnt, 1).Value = pLabel(p) & " 인원"
        ws.Cells(rowReq, 1).Value = pLabel(p) & " 필요"
        ws.Cells(rowReq, 1).Font.Color = RGB(120, 120, 130)
        For d = 1 To nD
            colL = Split(ws.Cells(1, 1 + d).Address(True, False), "$")(0)
            rng = colL & "5:" & colL & (4 + nN)
            ' D/DC/D/A 모두 첫 글자로 판정 (D1·중 등 다른 코드는 첫 글자가 다름)
            ws.Cells(rowCnt, 1 + d).Formula = _
                "=SUMPRODUCT(--(LEFT(" & rng & ",1)=""" & pLabel(p) & """))"
            wd = Weekday(DateSerial(y, m, d), vbMonday)
            ws.Cells(rowReq, 1 + d).Value = req(p + 1, wd)
            ' 인원<>필요면 빨간색
            With ws.Cells(rowCnt, 1 + d).FormatConditions.Add(Type:=xlExpression, _
                 Formula1:="=" & colL & rowCnt & "<>" & colL & rowReq)
                .Font.Color = RGB(200, 40, 40)
                .Font.Bold = True
            End With
        Next d
    Next p

    ' 모양새 (깔끔·사무용)
    SheetBase ws
    TitleStyle ws.Range("A1"), 13
    MuteStyle ws.Range("A2")
    ws.Columns(1).ColumnWidth = 12
    ws.Range(ws.Columns(2), ws.Columns(1 + nD)).ColumnWidth = 4.5
    ' 근무 입력 그리드
    ws.Range(ws.Cells(5, 1), ws.Cells(4 + nN, 1)).HorizontalAlignment = xlLeft
    ws.Range(ws.Cells(5, 2), ws.Cells(4 + nN, 1 + nD)).HorizontalAlignment = xlCenter
    BoxBorders ws.Range(ws.Cells(3, 1), ws.Cells(4 + nN, 1 + nD))
    ' 인원/필요 카운트 블록 — 옅은 배경 + 상단 구분선으로 스케줄과 분리
    ws.Range(ws.Cells(base, 1), ws.Cells(base + 5, 1 + nD)).Interior.Color = RGB(248, 249, 251)
    ws.Range(ws.Cells(base, 1), ws.Cells(base + 5, 1)).Font.Color = RGB(90, 96, 110)
    ws.Range(ws.Cells(base, 2), ws.Cells(base + 5, 1 + nD)).HorizontalAlignment = xlCenter
    BoxBorders ws.Range(ws.Cells(base, 1), ws.Cells(base + 5, 1 + nD))
    With ws.Range(ws.Cells(base, 1), ws.Cells(base, 1 + nD)).Borders(xlEdgeTop)
        .LineStyle = xlContinuous: .Color = RGB(150, 158, 172): .Weight = xlMedium
    End With
    ws.Rows("3:" & (base + 5)).RowHeight = 17
    ws.Rows(1).RowHeight = 22
    ws.Activate
    ws.Cells(5, 2).Select
    ActiveWindow.FreezePanes = False
    ActiveWindow.FreezePanes = True

    ' [어싸인 배정] 버튼
    Dim btn As Button
    Set btn = ws.Buttons.Add(ws.Range("F1").Left, ws.Range("F1").Top, 110, 26)
    btn.OnAction = "어싸인배정실행"
    btn.Caption = "어싸인 배정 →"

    Application.ScreenUpdating = True
    If Not 조용히 Then MsgBox shName & " 시트를 만들었습니다." & vbLf & _
           "근무를 입력한 뒤 [어싸인 배정] 버튼을 누르세요.", vbInformation
End Sub

' ══════════════════════════════════════════════════════════════
' 매크로 3: 어싸인 배정 (근무표 시트의 버튼이 호출)
' ══════════════════════════════════════════════════════════════
Private Sub 어싸인_코어(Optional 조용히 As Boolean = False)
    Dim src As Worksheet: Set src = ActiveSheet
    If Left(src.Name, 4) <> "근무표_" Then
        If Not 조용히 Then MsgBox "근무표_YYYY-MM 시트에서 실행하세요.", vbExclamation
        Exit Sub
    End If
    If Not SheetExists("설정") Then
        If Not 조용히 Then MsgBox "설정 시트가 없습니다. [초기세팅생성]을 먼저 실행하세요.", vbExclamation
        Exit Sub
    End If
    Dim ym As String: ym = Mid(src.Name, 5)

    ' ── 설정 읽기 ──
    Dim cfg As Worksheet: Set cfg = ThisWorkbook.Worksheets("설정")
    Dim rule1 As Boolean, rule2 As Boolean, rule3 As Boolean, rule4 As Boolean
    Dim warns As String
    Dim rr As Long: rr = FindAnchorRow(cfg, "■ 배정 원칙")
    If rr = 0 Then
        If Not 조용히 Then MsgBox "설정 시트에서 ""■ 배정 원칙"" 섹션을 찾지 못했습니다.", vbExclamation
        Exit Sub
    End If
    rule1 = (UCase(Trim(cfg.Cells(rr + 1, 11).Value)) = "O")   ' 전일 같은 근무 유지
    rule2 = (UCase(Trim(cfg.Cells(rr + 2, 11).Value)) = "O")   ' 근무 바뀌어도 유지
    rule3 = (UCase(Trim(cfg.Cells(rr + 3, 11).Value)) = "O")   ' 오프 복귀자 유지
    rule4 = (UCase(Trim(cfg.Cells(rr + 4, 11).Value)) = "O")   ' 오프 복귀자 튕기기
    If rule3 And rule4 Then
        ' 유지와 튕기기는 반대 개념 — 동시 O면 원칙3만 적용 (설정 시트 안내와 동일)
        rule4 = False
        warns = warns & "· 설정: 원칙3(오프 복귀 유지)과 원칙4(튕기기)가 동시에 O — 원칙4 무시됨" & vbLf
    End If

    ' 간호사 속성: 이름 → 차지가능 / 가능근무
    Dim attrName() As String, attrCharge() As Boolean, attrCap() As String, nAttr As Long
    nAttr = ReadNurseAttrs(attrName, attrCharge, attrCap)

    ' 방 정보: 방번호 → 유형
    Dim roomNo() As String, roomType() As String, nRoom As Long
    nRoom = ReadRooms(roomNo, roomType)

    ' 방 구성: schemeRooms(인원수 2~5, 라벨) → "1001, 1002"
    Dim schemeMap(2 To 5, 0 To 4) As String
    ReadSchemes schemeMap

    ' ── 근무표 그리드 읽기 ──
    Dim nD As Long: nD = 0
    Do While IsNumeric(src.Cells(3, 2 + nD).Value) And src.Cells(3, 2 + nD).Value <> ""
        nD = nD + 1
    Loop
    Dim nN As Long: nN = 0
    Do While Trim(src.Cells(5 + nN, 1).Value) <> ""
        If InStr(src.Cells(5 + nN, 1).Value, "인원") > 0 Then Exit Do
        nN = nN + 1
    Loop
    If nD = 0 Or nN = 0 Then
        If Not 조용히 Then MsgBox "근무표에 데이터가 없습니다.", vbExclamation
        Exit Sub
    End If

    Dim names() As String: ReDim names(1 To nN)
    Dim chargeCap() As Boolean: ReDim chargeCap(1 To nN)
    Dim capable() As String: ReDim capable(1 To nN)
    Dim shiftC() As String: ReDim shiftC(1 To nN, 1 To nD)
    Dim preLab() As String: ReDim preLab(1 To nN, 1 To nD)
    Dim i As Long, j As Long, k As Long

    For i = 1 To nN
        names(i) = Trim(src.Cells(4 + i, 1).Value)
        chargeCap(i) = False: capable(i) = ""
        For k = 1 To nAttr
            If attrName(k) = names(i) Then
                chargeCap(i) = attrCharge(k): capable(i) = attrCap(k): Exit For
            End If
        Next k
        If capable(i) = "" And k > nAttr Then _
            warns = warns & "· " & names(i) & ": 설정 시트에 없음 (차지 불가로 간주)" & vbLf
        For j = 1 To nD
            ParseCell CStr(src.Cells(4 + i, 1 + j).Value), shiftC(i, j), preLab(i, j)
            ' 가능근무 검증 (설정에 O 없는 근무 입력 시 경고만)
            If shiftC(i, j) <> "" And capable(i) <> "" Then
                If InStr(capable(i), "|" & shiftC(i, j) & "|") = 0 Then _
                    warns = warns & "· " & names(i) & " " & j & "일: " & shiftC(i, j) & " (설정상 불가 근무)" & vbLf
            End If
        Next j
    Next i

    ' ── 배정 알고리즘 ──
    Dim LABELS As Variant: LABELS = Array("차지", "A", "B", "C", "D")
    Dim lastLabel() As String, lastIdx() As Long, lastPeriod() As String
    ReDim lastLabel(1 To nN): ReDim lastIdx(1 To nN): ReDim lastPeriod(1 To nN)
    For i = 1 To nN: lastIdx(i) = -99: Next i

    Dim resLabel() As String, resPeriod() As String, resCnt() As Long, resFixed() As Boolean
    ReDim resLabel(1 To nN, 1 To nD): ReDim resPeriod(1 To nN, 1 To nD)
    ReDim resCnt(1 To nN, 1 To nD): ReDim resFixed(1 To nN, 1 To nD)

    Dim periods As Variant: periods = Array("D", "E", "N")
    Dim p As Long, t As Long, li As Long, ss As Long

    For j = 1 To nD
        For p = 0 To 2
            Dim PP As String: PP = periods(p)
            Dim staff() As Long, ns As Long: ns = 0
            ReDim staff(1 To nN)
            For i = 1 To nN
                If PeriodOf(shiftC(i, j)) = PP Then ns = ns + 1: staff(ns) = i
            Next i
            If ns = 0 Then GoTo NextPeriod

            Dim nLab As Long: nLab = ns
            If nLab > MAX_LABELS Then nLab = MAX_LABELS
            Dim asgn(0 To 4) As Long
            For li = 0 To 4: asgn(li) = 0: Next li
            Dim takenN() As Boolean: ReDim takenN(1 To nN)

            ' 0) 선입력 라벨 (D/A 식) — 최우선 고정
            For ss = 1 To ns
                i = staff(ss)
                If preLab(i, j) <> "" Then
                    Dim hit As Boolean: hit = False
                    For li = 0 To nLab - 1
                        If LABELS(li) = preLab(i, j) Then
                            If asgn(li) = 0 Then
                                asgn(li) = i: takenN(i) = True: resFixed(i, j) = True: hit = True
                            Else
                                warns = warns & "· " & names(i) & " " & j & "일: 선입력 " & preLab(i, j) & _
                                        " 중복 — 무시됨" & vbLf
                                hit = True
                            End If
                            Exit For
                        End If
                    Next li
                    If Not hit Then warns = warns & "· " & names(i) & " " & j & "일: 선입력 라벨 " & _
                        preLab(i, j) & " 이 " & ns & "인 구성에 없음 — 무시됨" & vbLf
                End If
            Next ss

            ' 1) 차지: DC/EC/NC 표시자 → 차지가능 최선임 → 최선임
            If asgn(0) = 0 Then
                For ss = 1 To ns
                    i = staff(ss)
                    If Not takenN(i) And IsChargeCode(shiftC(i, j)) Then
                        asgn(0) = i: takenN(i) = True: Exit For
                    End If
                Next ss
            End If
            If asgn(0) = 0 Then
                For ss = 1 To ns
                    i = staff(ss)
                    If Not takenN(i) And chargeCap(i) Then asgn(0) = i: takenN(i) = True: Exit For
                Next ss
            End If
            If asgn(0) = 0 Then
                For ss = 1 To ns
                    i = staff(ss)
                    If Not takenN(i) Then asgn(0) = i: takenN(i) = True: Exit For
                Next ss
            End If

            ' 원칙 1~3) 연속성 계층 — 앞 계층 우선
            For t = 1 To 3
                If (t = 1 And Not rule1) Or (t = 2 And Not rule2) Or (t = 3 And Not rule3) Then GoTo NextTier
                For li = 1 To nLab - 1
                    If asgn(li) = 0 Then
                        Dim best As Long, bestIdx As Long: best = 0: bestIdx = -99
                        For ss = 1 To ns
                            i = staff(ss)
                            If Not takenN(i) And lastLabel(i) = LABELS(li) Then
                                Dim ok As Boolean: ok = False
                                If t = 1 Then ok = (lastIdx(i) = j - 1 And lastPeriod(i) = PP)
                                If t = 2 Then ok = (lastIdx(i) = j - 1 And lastPeriod(i) <> PP)
                                If t = 3 Then ok = (lastIdx(i) < j - 1 And lastIdx(i) > -99)
                                If ok And lastIdx(i) > bestIdx Then best = i: bestIdx = lastIdx(i)
                            End If
                        Next ss
                        If best > 0 Then asgn(li) = best: takenN(best) = True
                    End If
                Next li
NextTier:
            Next t

            ' 잔여: 연차(행) 순으로 남은 라벨 채움
            ' 원칙4(튕기기): 오프 복귀자에겐 이전 방 라벨을 피해서 배정 — 1차에서 튕기고,
            ' 다른 후보가 없으면 2차에서 그대로 배정 (라벨 미충원 방지)
            Dim pass As Long
            For li = 0 To nLab - 1
                For pass = 1 To 2
                    If asgn(li) = 0 Then
                        For ss = 1 To ns
                            i = staff(ss)
                            If Not takenN(i) Then
                                If pass = 1 And rule4 And LABELS(li) = lastLabel(i) _
                                   And lastIdx(i) < j - 1 And lastIdx(i) > -99 Then
                                    ' 오프 복귀자 튕김 — 다음 후보에게
                                Else
                                    asgn(li) = i: takenN(i) = True: Exit For
                                End If
                            End If
                        Next ss
                    End If
                Next pass
            Next li

            ' 기록 (+ 6인 이상 잔여 = 헬퍼)
            For li = 0 To nLab - 1
                If asgn(li) > 0 Then
                    i = asgn(li)
                    resLabel(i, j) = LABELS(li): resPeriod(i, j) = PP: resCnt(i, j) = ns
                    lastLabel(i) = LABELS(li): lastIdx(i) = j: lastPeriod(i) = PP
                End If
            Next li
            For ss = 1 To ns
                i = staff(ss)
                If Not takenN(i) Then
                    resLabel(i, j) = "—": resPeriod(i, j) = PP: resCnt(i, j) = ns
                End If
            Next ss
NextPeriod:
        Next p
    Next j

    ' ── 출력 ──
    Application.ScreenUpdating = False
    WriteGrid ym, names, nN, nD, resLabel, resPeriod, resFixed
    WriteDetail ym, names, nN, nD, resLabel, resPeriod, resCnt, schemeMap, roomNo, roomType, nRoom
    Application.ScreenUpdating = True

    Dim msg As String
    msg = "어싸인 배정 완료 → ""어싸인_" & ym & """ / ""어싸인상세_" & ym & """ 시트"
    If warns <> "" Then msg = msg & vbLf & vbLf & "⚠ 확인 필요:" & vbLf & warns
    If Not 조용히 Then MsgBox msg, IIf(warns = "", vbInformation, vbExclamation)
    ThisWorkbook.Worksheets("어싸인_" & ym).Activate
End Sub

' ══════════════════════════════════════════════════════════════
' 출력 시트
' ══════════════════════════════════════════════════════════════
Private Sub WriteGrid(ym As String, names() As String, nN As Long, nD As Long, _
                      resLabel() As String, resPeriod() As String, resFixed() As Boolean)
    Dim wo As Worksheet: Set wo = GetCleanSheet("어싸인_" & ym)
    wo.Range("A1").Value = ym & " 어싸인표"
    wo.Range("A2").Value = "DC EC NC=차지 · D/A E/B=근무/방 · 색=근무(D 파랑·E 초록·N 주황) · 굵게=선입력 고정 · /—=헬퍼"
    Dim i As Long, j As Long
    wo.Cells(3, 1).Value = "이름"
    For j = 1 To nD: wo.Cells(3, 1 + j).Value = j: Next j
    HeadStyle wo.Range(wo.Cells(3, 1), wo.Cells(3, 1 + nD))
    wo.Cells(3, 1).HorizontalAlignment = xlLeft
    For i = 1 To nN
        wo.Cells(3 + i, 1).Value = names(i)
        For j = 1 To nD
            If resLabel(i, j) <> "" Then
                Dim cellTxt As String
                If resLabel(i, j) = "차지" Then
                    cellTxt = resPeriod(i, j) & "C"                       ' DC EC NC
                ElseIf resLabel(i, j) = "—" Then
                    cellTxt = resPeriod(i, j) & "/—"                      ' 헬퍼
                Else
                    cellTxt = resPeriod(i, j) & "/" & resLabel(i, j)      ' D/A E/B
                End If
                wo.Cells(3 + i, 1 + j).Value = cellTxt
                If resFixed(i, j) Then wo.Cells(3 + i, 1 + j).Font.Bold = True
                Select Case resPeriod(i, j)
                    Case "D": wo.Cells(3 + i, 1 + j).Interior.Color = RGB(217, 233, 255)
                    Case "E": wo.Cells(3 + i, 1 + j).Interior.Color = RGB(214, 245, 227)
                    Case "N": wo.Cells(3 + i, 1 + j).Interior.Color = RGB(255, 230, 199)
                End Select
            End If
        Next j
    Next i
    ' 모양새 (깔끔·사무용)
    SheetBase wo
    TitleStyle wo.Range("A1"), 13
    MuteStyle wo.Range("A2")
    wo.Columns(1).ColumnWidth = 12
    wo.Range(wo.Columns(2), wo.Columns(1 + nD)).ColumnWidth = 5.5
    wo.Range(wo.Cells(4, 1), wo.Cells(3 + nN, 1)).HorizontalAlignment = xlLeft
    wo.Range(wo.Cells(4, 2), wo.Cells(3 + nN, 1 + nD)).HorizontalAlignment = xlCenter
    BoxBorders wo.Range(wo.Cells(3, 1), wo.Cells(3 + nN, 1 + nD))
    wo.Rows("3:" & (3 + nN)).RowHeight = 18
    wo.Rows(1).RowHeight = 22
    wo.Activate
    wo.Cells(4, 2).Select
    ActiveWindow.FreezePanes = False
    ActiveWindow.FreezePanes = True
End Sub

Private Sub WriteDetail(ym As String, names() As String, nN As Long, nD As Long, _
                        resLabel() As String, resPeriod() As String, resCnt() As Long, _
                        schemeMap() As String, roomNo() As String, roomType() As String, nRoom As Long)
    Dim wd As Worksheet: Set wd = GetCleanSheet("어싸인상세_" & ym)
    Dim LABELS As Variant: LABELS = Array("차지", "A", "B", "C", "D")
    Dim periods As Variant: periods = Array("D", "E", "N")
    wd.Range("A1").Value = ym & " 어싸인 상세"
    wd.Range("A2:E2").Value = Array("날짜", "시간대", "어싸인", "간호사", "병실")
    Dim r As Long: r = 3
    Dim j As Long, p As Long, li As Long, i As Long
    For j = 1 To nD
        For p = 0 To 2
            For li = 0 To 4
                For i = 1 To nN
                    If resPeriod(i, j) = periods(p) And resLabel(i, j) = LABELS(li) Then
                        wd.Cells(r, 1).Value = j
                        wd.Cells(r, 2).Value = periods(p)
                        wd.Cells(r, 3).Value = LABELS(li)
                        wd.Cells(r, 4).Value = names(i)
                        wd.Cells(r, 5).Value = RoomsStr(schemeMap, resCnt(i, j), li, roomNo, roomType, nRoom)
                        r = r + 1
                    End If
                Next i
            Next li
            For i = 1 To nN
                If resPeriod(i, j) = periods(p) And resLabel(i, j) = "—" Then
                    wd.Cells(r, 1).Value = j
                    wd.Cells(r, 2).Value = periods(p)
                    wd.Cells(r, 3).Value = "헬퍼"
                    wd.Cells(r, 4).Value = names(i)
                    r = r + 1
                End If
            Next i
        Next p
    Next j
    Dim lastRow As Long: lastRow = r - 1

    ' 서식 (깔끔·사무용)
    SheetBase wd
    TitleStyle wd.Range("A1"), 13
    HeadStyle wd.Range("A2:E2")
    BottomRule wd.Range("A2:E2")
    If lastRow >= 3 Then
        BoxBorders wd.Range("A2:E" & lastRow)
        wd.Range("A3:C" & lastRow).HorizontalAlignment = xlCenter
        wd.Range("D3:E" & lastRow).HorizontalAlignment = xlLeft
        Dim rr As Long
        For rr = 3 To lastRow          ' 날짜별 옅은 밴딩 (짝수 날)
            If (wd.Cells(rr, 1).Value Mod 2) = 0 Then _
                wd.Range("A" & rr & ":E" & rr).Interior.Color = RGB(248, 249, 251)
        Next rr
    End If
    wd.Columns(1).ColumnWidth = 6
    wd.Columns(2).ColumnWidth = 8
    wd.Columns(3).ColumnWidth = 8
    wd.Columns(4).ColumnWidth = 12
    wd.Columns(5).ColumnWidth = 34
    wd.Rows(1).RowHeight = 22
    wd.Activate
    wd.Range("A3").Select
    ActiveWindow.FreezePanes = False
    ActiveWindow.FreezePanes = True
End Sub

' 방 목록 문자열: "1001호(5인실) 1002호(5인실)"
Private Function RoomsStr(schemeMap() As String, cnt As Long, labelIdx As Long, _
                          roomNo() As String, roomType() As String, nRoom As Long) As String
    Dim c As Long: c = cnt
    If c < 2 Then c = 2
    If c > 5 Then c = 5
    Dim raw As String: raw = schemeMap(c, labelIdx)
    If Trim(raw) = "" Then RoomsStr = "(수동 분배)": Exit Function
    Dim parts As Variant: parts = Split(raw, ",")
    Dim out As String, k As Long, q As Long, tp As String
    For k = 0 To UBound(parts)
        Dim rm As String: rm = Trim(parts(k))
        If rm <> "" Then
            tp = ""
            For q = 1 To nRoom
                If roomNo(q) = rm Then tp = roomType(q): Exit For
            Next q
            out = out & rm & "호" & IIf(tp <> "", "(" & tp & ")", "") & " "
        End If
    Next k
    RoomsStr = Trim(out)
End Function

' ══════════════════════════════════════════════════════════════
' 설정 시트 읽기 헬퍼
' ══════════════════════════════════════════════════════════════
Private Function ReadNurseNames(ByRef names() As String) As Long
    Dim cfg As Worksheet: Set cfg = ThisWorkbook.Worksheets("설정")
    Dim n As Long: n = 0
    Do While Trim(cfg.Cells(5 + n, 1).Value) <> ""
        n = n + 1
    Loop
    If n = 0 Then ReadNurseNames = 0: Exit Function
    ReDim names(1 To n)
    Dim i As Long
    For i = 1 To n: names(i) = Trim(cfg.Cells(4 + i, 1).Value): Next i
    ReadNurseNames = n
End Function

' 이름 / 차지가능 / 가능근무("|DC|D|..." 형식)
Private Function ReadNurseAttrs(ByRef nm() As String, ByRef chg() As Boolean, ByRef cap() As String) As Long
    Dim cfg As Worksheet: Set cfg = ThisWorkbook.Worksheets("설정")
    Dim codes As Variant: codes = Array("DC", "D", "EC", "E", "NC", "N")
    Dim n As Long: n = ReadNurseNames(nm)
    If n = 0 Then ReadNurseAttrs = 0: Exit Function
    ReDim chg(1 To n): ReDim cap(1 To n)
    Dim i As Long, c As Long
    For i = 1 To n
        cap(i) = "|"
        For c = 0 To 5
            If UCase(Trim(cfg.Cells(4 + i, 2 + c).Value)) = "O" Then
                cap(i) = cap(i) & codes(c) & "|"
                If c = 0 Or c = 2 Or c = 4 Then chg(i) = True   ' DC/EC/NC
            End If
        Next c
    Next i
    ReadNurseAttrs = n
End Function

' 설정 시트 J열에서 "■ ..." 섹션 헤더 행 찾기 (0 = 못 찾음)
Private Function FindAnchorRow(cfg As Worksheet, anchor As String) As Long
    Dim c As Range
    Set c = cfg.Columns(10).Find(anchor, LookAt:=xlPart, LookIn:=xlValues)
    If c Is Nothing Then FindAnchorRow = 0 Else FindAnchorRow = c.Row
End Function

' 요일별 필요인원: req(1..3=D/E/N, 1..7=월~일)
Private Function ReadWeekdayReq() As Variant
    Dim cfg As Worksheet: Set cfg = ThisWorkbook.Worksheets("설정")
    Dim req(1 To 3, 1 To 7) As Long
    Dim base As Long: base = FindAnchorRow(cfg, "■ 요일별 필요인원") + 1  ' 헤더 행
    Dim p As Long, w As Long
    For p = 1 To 3
        For w = 1 To 7
            req(p, w) = Val(cfg.Cells(base + p, 10 + w).Value)
        Next w
    Next p
    ReadWeekdayReq = req
End Function

Private Function ReadRooms(ByRef no() As String, ByRef tp() As String) As Long
    Dim cfg As Worksheet: Set cfg = ThisWorkbook.Worksheets("설정")
    Dim base As Long: base = FindAnchorRow(cfg, "■ 방 목록") + 1  ' 헤더 행
    Dim n As Long: n = 0
    Do While Trim(cfg.Cells(base + 1 + n, 10).Value) <> ""
        n = n + 1
    Loop
    If n = 0 Then ReadRooms = 0: Exit Function
    ReDim no(1 To n): ReDim tp(1 To n)
    Dim i As Long
    For i = 1 To n
        no(i) = Trim(CStr(cfg.Cells(base + i, 10).Value))
        tp(i) = Trim(CStr(cfg.Cells(base + i, 11).Value))
    Next i
    ReadRooms = n
End Function

' 방 구성: schemeMap(인원수 2~5, 라벨idx 0~4) = "1001, 1002"
Private Sub ReadSchemes(ByRef schemeMap() As String)
    Dim cfg As Worksheet: Set cfg = ThisWorkbook.Worksheets("설정")
    Dim LABELS As Variant: LABELS = Array("차지", "A", "B", "C", "D")
    Dim r As Long: r = FindAnchorRow(cfg, "■ 어싸인별 방 구성") + 2  ' 헤더 다음 행
    Do While Trim(cfg.Cells(r, 10).Value) <> ""
        Dim cnt As Long: cnt = Val(cfg.Cells(r, 10).Value)   ' "5인" → 5
        Dim lab As String: lab = Trim(cfg.Cells(r, 11).Value)
        Dim li As Long
        If cnt >= 2 And cnt <= 5 Then
            For li = 0 To 4
                If LABELS(li) = lab Then schemeMap(cnt, li) = CStr(cfg.Cells(r, 12).Value): Exit For
            Next li
        End If
        r = r + 1
    Loop
End Sub

' ══════════════════════════════════════════════════════════════
' 공용 헬퍼
' ══════════════════════════════════════════════════════════════
' 셀 → 근무코드 + 선입력 라벨 ("D/A" → shift="D", label="A")
Private Sub ParseCell(ByVal v As String, ByRef shiftCode As String, ByRef preLabel As String)
    shiftCode = "": preLabel = ""
    v = UCase(Replace(Trim(v), " ", ""))
    If v = "" Then Exit Sub
    If Left(v, 1) = "/" Then Exit Sub          ' 트레이니 표기 등 — 제외
    Dim sh As String, lb As String
    If InStr(v, "/") > 0 Then
        sh = Split(v, "/")(0)
        lb = Split(v, "/")(1)
    Else
        sh = v
    End If
    Select Case sh
        Case "DC", "D", "EC", "E", "NC", "N"
            shiftCode = sh
        Case Else
            Exit Sub                            ' OF·주·V·중·D1 등 — 어싸인 제외
    End Select
    Select Case lb
        Case "A", "B", "C", "D": preLabel = lb
        Case "차지": preLabel = "차지"
    End Select
End Sub

Private Function PeriodOf(code As String) As String
    Select Case code
        Case "DC", "D": PeriodOf = "D"
        Case "EC", "E": PeriodOf = "E"
        Case "NC", "N": PeriodOf = "N"
        Case Else: PeriodOf = ""
    End Select
End Function

Private Function IsChargeCode(code As String) As Boolean
    IsChargeCode = (code = "DC" Or code = "EC" Or code = "NC")
End Function

Private Function SheetExists(nm As String) As Boolean
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(nm)
    On Error GoTo 0
    SheetExists = Not ws Is Nothing
End Function

Private Function GetCleanSheet(nm As String) As Worksheet
    If SheetExists(nm) Then
        Set GetCleanSheet = ThisWorkbook.Worksheets(nm)
        GetCleanSheet.Cells.Clear
    Else
        Set GetCleanSheet = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
        GetCleanSheet.Name = nm
    End If
End Function
