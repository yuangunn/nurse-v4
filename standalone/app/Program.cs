namespace AssignApp;

internal static class Program
{
    /// <summary>
    /// 어싸인 배정표 — 단일 실행 파일.
    ///   어싸인배정표.exe                      exe 옆(또는 assign.ini 가 가리키는) 데이터 파일
    ///   어싸인배정표.exe "\\nas\...\5A.json"  데이터 파일을 직접 지정
    ///   어싸인배정표.exe --dev                개발자 도구·우클릭 메뉴 켜기
    /// </summary>
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        try
        {
            Application.Run(new MainForm(args));
        }
        catch (Exception e)
        {
            try
            {
                File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "assign_error.log"),
                                   $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {e}\n");
            }
            catch (IOException) { }
            MessageBox.Show(e.Message, "어싸인 배정표 — 오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
