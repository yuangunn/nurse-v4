Attribute VB_Name = "어싸인배정"
Option Explicit
' ════════════════════════════════════════════════════════════════════
' 어싸인 자동 배정 — Excel VBA (인트라넷용)
'
' 사용법:
'   1. Alt+F11 → 파일 > 파일 가져오기 → 이 .bas 파일
'   2. "근무표" 시트 준비:
'        - 1행: B1부터 날짜 (1, 2, 3 ... 또는 아무 헤더)
'        - A열: 2행부터 간호사 이름 (위 = 선임, 행 순서가 연차 순)
'        - B1 셀이 "차지" 면 B열 = 차지가능(O/X), 근무 데이터는 C열부터
'        - 셀 값: DC, D, EC, E, NC, N (그 외 OF·중·D1 등은 자동 무시)
'   3. Alt+F8 → 어싸인배정실행
'   4. "어싸인" 시트(월 그리드) + "어싸인상세" 시트(일별 표) 생성됨
'
' 배정 원칙 (nurse-v4 assign-core.js 와 동일 로직):
'   1. 차지 = DC/EC/NC 표시자 우선, 없으면 차지가능 최선임
'   2. 전일 같은 근무 → 봤던 방(라벨) 유지 (최우선)
'   3. 전일 다른 근무 → 봤던 방 유지
'   4. 오프 복귀자 → 봤던 방 유지
'   원칙 on/off: 아래 RULE_2/RULE_3/RULE_4 상수 수정
' ════════════════════════════════════════════════════════════════════

Private Const RULE_2 As Boolean = True   ' 전일 같은 근무 방 유지
Private Const RULE_3 As Boolean = True   ' 근무 변경 시 방 유지
Private Const RULE_4 As Boolean = True   ' 오프 복귀자 방 유지

' ── 인원수별 방 구성 (수정은 여기서) ────────────────────────────────
Private Function SchemeRooms(cnt As Long, label As String) As String
    Select Case cnt
        Case Is >= 5
            Select Case label
                Case "차지": SchemeRooms = "1012, 1014"
                Case "A": SchemeRooms = "1001, 1002"
                Case "B": SchemeRooms = "1003, 1004"
                Case "C": SchemeRooms = "1005, 1010, 1011"
                Case "D": SchemeRooms = "1006, 1007, 1008, 1009"
            End Select
        Case 4
            Select Case label
                Case "차지": SchemeRooms = "1001, 1014"
                Case "A": SchemeRooms = "1002, 1003, 1012"
                Case "B": SchemeRooms = "1004, 1005, 1011"
                Case "C": SchemeRooms = "1006, 1007, 1008, 1009, 1010"
            End Select
        Case 3
            Select Case label
                Case "차지": SchemeRooms = "1001, 1012, 1014"
                Case "A": SchemeRooms = "1002, 1003, 1004, 1011"
                Case "B": SchemeRooms = "1005, 1006, 1007, 1008, 1009, 1010"
            End Select
        Case Else ' 2인: 환자 수에 따라 이전 근무 차지가 수동 분배
            SchemeRooms = "(수동 분배)"
    End Select
End Function

Private Function PeriodOf(code As String) As String
    Dim c As String: c = UCase(Trim(code))
    Select Case c
        Case "DC", "D": PeriodOf = "D"
        Case "EC", "E": PeriodOf = "E"
        Case "NC", "N": PeriodOf = "N"
        Case Else: PeriodOf = ""
    End Select
End Function

Private Function IsChargeCode(code As String) As Boolean
    Dim c As String: c = UCase(Trim(code))
    IsChargeCode = (c = "DC" Or c = "EC" Or c = "NC")
End Function

Public Sub 어싸인배정실행()
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets("근무표")
    On Error GoTo 0
    If ws Is Nothing Then MsgBox """근무표"" 시트가 없습니다.", vbExclamation: Exit Sub

    ' ── 입력 읽기 ──
    Dim hasChargeCol As Boolean: hasChargeCol = (Trim(ws.Cells(1, 2).Value) = "차지")
    Dim dataCol As Long: dataCol = IIf(hasChargeCol, 3, 2)
    Dim nN As Long: nN = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row - 1
    Dim nD As Long: nD = ws.Cells(1, ws.Columns.Count).End(xlToLeft).Column - dataCol + 1
    If nN < 1 Or nD < 1 Then MsgBox "근무표 데이터가 없습니다.", vbExclamation: Exit Sub

    Dim names() As String, chargeCap() As Boolean, code() As String, dayHdr() As String
    ReDim names(1 To nN): ReDim chargeCap(1 To nN)
    ReDim code(1 To nN, 1 To nD): ReDim dayHdr(1 To nD)
    Dim i As Long, j As Long
    For i = 1 To nN
        names(i) = Trim(ws.Cells(i + 1, 1).Value)
        chargeCap(i) = True
        If hasChargeCol Then chargeCap(i) = (UCase(Trim(ws.Cells(i + 1, 2).Value)) <> "X")
        For j = 1 To nD
            code(i, j) = Trim(ws.Cells(i + 1, dataCol + j - 1).Value)
        Next j
    Next i
    For j = 1 To nD: dayHdr(j) = CStr(ws.Cells(1, dataCol + j - 1).Value): Next j

    ' ── 배정 상태 ──
    Dim LABELS As Variant: LABELS = Array("차지", "A", "B", "C", "D")
    Dim lastLabel() As String, lastIdx() As Long, lastPeriod() As String
    ReDim lastLabel(1 To nN): ReDim lastIdx(1 To nN): ReDim lastPeriod(1 To nN)
    For i = 1 To nN: lastIdx(i) = -99: Next i

    ' 결과: resLabel(i,j) = 라벨 or "—"(헬퍼) or ""
    Dim resLabel() As String, resPeriod() As String, resCnt() As Long
    ReDim resLabel(1 To nN, 1 To nD): ReDim resPeriod(1 To nN, 1 To nD)
    ReDim resCnt(1 To nN, 1 To nD)

    Dim periods As Variant: periods = Array("D", "E", "N")
    Dim p As Long, t As Long, li As Long, s As Long

    For j = 1 To nD
        For p = 0 To 2
            Dim PP As String: PP = periods(p)
            ' 해당 시간대 근무자 수집 (행 순서 = 연차 순)
            Dim staff() As Long, ns As Long: ns = 0
            ReDim staff(1 To nN)
            For i = 1 To nN
                If PeriodOf(code(i, j)) = PP Then ns = ns + 1: staff(ns) = i
            Next i
            If ns = 0 Then GoTo NextPeriod

            Dim nLab As Long: nLab = IIf(ns > 5, 5, ns)
            Dim asgn() As Long: ReDim asgn(0 To 4)   ' 라벨 idx → 간호사 idx (0=미배정)
            Dim takenN() As Boolean: ReDim takenN(1 To nN)

            ' 1) 차지: DC/EC/NC 표시자 → 차지가능 최선임 → 최선임
            For s = 1 To ns
                If IsChargeCode(code(staff(s), j)) Then asgn(0) = staff(s): takenN(staff(s)) = True: Exit For
            Next s
            If asgn(0) = 0 Then
                For s = 1 To ns
                    If chargeCap(staff(s)) Then asgn(0) = staff(s): takenN(staff(s)) = True: Exit For
                Next s
            End If
            If asgn(0) = 0 Then asgn(0) = staff(1): takenN(staff(1)) = True

            ' 2~4) 연속성 계층 — 앞 계층 우선
            For t = 1 To 3
                If (t = 1 And Not RULE_2) Or (t = 2 And Not RULE_3) Or (t = 3 And Not RULE_4) Then GoTo NextTier
                For li = 1 To nLab - 1   ' 차지(0) 제외한 빈 라벨
                    If asgn(li) = 0 Then
                        Dim best As Long, bestIdx As Long: best = 0: bestIdx = -99
                        For s = 1 To ns
                            i = staff(s)
                            If Not takenN(i) And lastLabel(i) = LABELS(li) Then
                                Dim hit As Boolean: hit = False
                                If t = 1 Then hit = (lastIdx(i) = j - 1 And lastPeriod(i) = PP)
                                If t = 2 Then hit = (lastIdx(i) = j - 1 And lastPeriod(i) <> PP)
                                If t = 3 Then hit = (lastIdx(i) < j - 1 And lastIdx(i) > -99)
                                If hit And lastIdx(i) > bestIdx Then best = i: bestIdx = lastIdx(i)
                            End If
                        Next s
                        If best > 0 Then asgn(li) = best: takenN(best) = True
                    End If
                Next li
NextTier:
            Next t

            ' 5) 잔여: 연차 순으로 남은 라벨 채움
            For li = 0 To nLab - 1
                If asgn(li) = 0 Then
                    For s = 1 To ns
                        If Not takenN(staff(s)) Then asgn(li) = staff(s): takenN(staff(s)) = True: Exit For
                    Next s
                End If
            Next li

            ' 기록 (라벨 못 받은 6인째부터는 헬퍼)
            For li = 0 To nLab - 1
                If asgn(li) > 0 Then
                    i = asgn(li)
                    resLabel(i, j) = LABELS(li): resPeriod(i, j) = PP: resCnt(i, j) = ns
                    lastLabel(i) = LABELS(li): lastIdx(i) = j: lastPeriod(i) = PP
                End If
            Next li
            For s = 1 To ns
                If Not takenN(staff(s)) Then
                    resLabel(staff(s), j) = "—": resPeriod(staff(s), j) = PP: resCnt(staff(s), j) = ns
                End If
            Next s
NextPeriod:
        Next p
    Next j

    ' ── 출력 1: "어싸인" 월 그리드 ──
    Dim wo As Worksheet: Set wo = GetCleanSheet("어싸인")
    wo.Cells(1, 1).Value = "간호사"
    For j = 1 To nD: wo.Cells(1, j + 1).Value = dayHdr(j): Next j
    For i = 1 To nN
        wo.Cells(i + 1, 1).Value = names(i)
        For j = 1 To nD
            If resLabel(i, j) <> "" Then
                wo.Cells(i + 1, j + 1).Value = IIf(resLabel(i, j) = "차지", "차", resLabel(i, j))
                Select Case resPeriod(i, j)
                    Case "D": wo.Cells(i + 1, j + 1).Interior.Color = RGB(217, 233, 255)
                    Case "E": wo.Cells(i + 1, j + 1).Interior.Color = RGB(214, 245, 227)
                    Case "N": wo.Cells(i + 1, j + 1).Interior.Color = RGB(255, 230, 199)
                End Select
            End If
        Next j
    Next i
    wo.Rows(1).Font.Bold = True: wo.Columns(1).Font.Bold = True
    wo.Columns.AutoFit

    ' ── 출력 2: "어싸인상세" (날짜/시간대/어싸인/간호사/병실) ──
    Dim wd As Worksheet: Set wd = GetCleanSheet("어싸인상세")
    wd.Range("A1:E1").Value = Array("날짜", "시간대", "어싸인", "간호사", "병실")
    wd.Rows(1).Font.Bold = True
    Dim r As Long: r = 2
    For j = 1 To nD
        For p = 0 To 2
            For li = 0 To 4
                For i = 1 To nN
                    If resPeriod(i, j) = periods(p) And resLabel(i, j) = LABELS(li) Then
                        wd.Cells(r, 1).Value = dayHdr(j)
                        wd.Cells(r, 2).Value = periods(p)
                        wd.Cells(r, 3).Value = LABELS(li)
                        wd.Cells(r, 4).Value = names(i)
                        wd.Cells(r, 5).Value = SchemeRooms(resCnt(i, j), CStr(LABELS(li)))
                        r = r + 1
                    End If
                Next i
            Next li
            For i = 1 To nN   ' 헬퍼
                If resPeriod(i, j) = periods(p) And resLabel(i, j) = "—" Then
                    wd.Cells(r, 1).Value = dayHdr(j)
                    wd.Cells(r, 2).Value = periods(p)
                    wd.Cells(r, 3).Value = "헬퍼"
                    wd.Cells(r, 4).Value = names(i)
                    r = r + 1
                End If
            Next i
        Next p
    Next j
    wd.Columns.AutoFit

    MsgBox "어싸인 배정 완료 — ""어싸인"" / ""어싸인상세"" 시트를 확인하세요.", vbInformation
End Sub

Private Function GetCleanSheet(nm As String) As Worksheet
    On Error Resume Next
    Set GetCleanSheet = ThisWorkbook.Worksheets(nm)
    On Error GoTo 0
    If GetCleanSheet Is Nothing Then
        Set GetCleanSheet = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
        GetCleanSheet.Name = nm
    Else
        GetCleanSheet.Cells.Clear
    End If
End Function
