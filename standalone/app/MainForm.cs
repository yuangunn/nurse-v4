using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AssignApp;

/// <summary>
/// 어싸인 배정표 창.
///
/// 화면은 exe 안에 넣어 둔 assign.html 을 WebView2 로 그린다. 브라우저를 띄우는 게
/// 아니라 이 창 안에 렌더러만 얹는 것이라 주소창도, 로컬 서버(127.0.0.1)도 없다.
/// 화면은 https://assign.local/ 이라는 가짜 주소로 메모리에서 바로 공급하므로
/// 임시 파일도 만들지 않고, 출처가 고정돼 화면 설정(테마 등)이 계속 남는다.
///
/// 파일 읽기·쓰기는 화면이 postMessage 로 요청하고 이 클래스가 네이티브로 처리한다
/// — 브라우저의 파일 권한 확인이 아예 개입하지 않는다.
/// </summary>
public sealed class MainForm : Form
{
    private const string Origin = "https://assign.local";
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly DataFile _data;
    private readonly bool _dev;
    private byte[]? _html;

    public MainForm(string[] args)
    {
        _dev = args.Contains("--dev");
        var pathArg = args.FirstOrDefault(a => !a.StartsWith("--"));
        _data = new DataFile(string.IsNullOrWhiteSpace(pathArg) ? null : System.IO.Path.GetFullPath(pathArg));

        Text = "어싸인 배정표";
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;
        Size = WindowState_Load(out var maximized);
        if (maximized) WindowState = FormWindowState.Maximized;
        try { Icon = new Icon(typeof(MainForm).Assembly.GetManifestResourceStream("app.ico") ?? Stream.Null); }
        catch (Exception) { /* 아이콘은 없어도 그만 */ }

        Controls.Add(_web);
        FormClosing += (_, _) => WindowState_Save();
        Load += async (_, _) => await StartAsync();
    }

    // ── 화면 띄우기 ──────────────────────────────────────────────────────
    private async Task StartAsync()
    {
        _html = ReadEmbedded("assign.html");
        if (_html is null)
        {
            Fatal("화면 파일(assign.html)이 프로그램 안에 없습니다. 빌드를 다시 해주세요.");
            return;
        }
        try
        {
            // 화면 설정(테마 등)이 남도록 사용자별 폴더에 저장
            var udf = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "NurseAssign", "webview");
            Directory.CreateDirectory(udf);
            var env = await CoreWebView2Environment.CreateAsync(null, udf);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception e)
        {
            Fatal("이 컴퓨터에 'Microsoft Edge WebView2 런타임'이 없습니다.\n\n" +
                  "Windows 10/11 에는 보통 들어 있습니다. 없다면 정보팀에 아래를 요청하세요.\n" +
                  "  Microsoft Edge WebView2 Runtime (Evergreen Standalone Installer)\n\n" +
                  "자세한 내용: " + e.Message);
            return;
        }

        var c = _web.CoreWebView2;
        c.Settings.AreDefaultContextMenusEnabled = _dev;   // 브라우저 우클릭 메뉴 숨김
        c.Settings.AreDevToolsEnabled = _dev;
        c.Settings.IsStatusBarEnabled = false;
        // Ctrl+C/V 는 이 앱의 핵심 입력 경로라 브라우저 단축키를 끄지 않는다
        // (끄면 Ctrl+P·Ctrl+F 만 막히는 게 아니라 위험 부담이 크다. Ctrl+R 은 무해 — 내용은 파일에 있다)
        c.Settings.AreBrowserAcceleratorKeysEnabled = true;
        c.Settings.IsSwipeNavigationEnabled = false;

        // 화면을 메모리에서 바로 공급 (임시 파일 없음)
        c.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All);
        c.WebResourceRequested += (_, e) =>
        {
            // 화면 문서만 응답 — favicon 같은 곁가지 요청에 3MB 를 돌려주지 않는다
            var path = new Uri(e.Request.Uri).AbsolutePath;
            if (path is "/" or "/index.html" or "/assign.html")
            {
                var body = new MemoryStream(_html!, writable: false);
                e.Response = c.Environment.CreateWebResourceResponse(
                    body, 200, "OK",
                    "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
            }
            else
            {
                e.Response = c.Environment.CreateWebResourceResponse(null, 404, "Not Found", "");
            }
        };
        c.WebMessageReceived += OnMessage;
        // 새 창·외부 링크는 열지 않는다 (병원 PC에서 엉뚱한 창이 뜨지 않게)
        c.NewWindowRequested += (_, e) => e.Handled = true;

        c.Navigate(Origin + "/index.html");
    }

    private static byte[]? ReadEmbedded(string name)
    {
        using var s = typeof(MainForm).Assembly.GetManifestResourceStream(name);
        if (s is null) return null;
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        return ms.ToArray();
    }

    private void Fatal(string msg)
    {
        MessageBox.Show(this, msg, "어싸인 배정표", MessageBoxButtons.OK, MessageBoxIcon.Error);
        // Load 처리 중에 바로 Close() 하면 창이 안 닫히는 경우가 있어 한 박자 뒤로 미룬다
        BeginInvoke(new Action(Close));
    }

    // ── 화면 ↔ 파일 다리 ────────────────────────────────────────────────
    private void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        long id = 0;
        try
        {
            string raw;
            try { raw = e.TryGetWebMessageAsString(); }
            catch (ArgumentException) { raw = e.WebMessageAsJson; }   // 객체로 온 경우도 받는다
            var msg = JsonNode.Parse(raw) as JsonObject;
            if (msg is null) return;
            id = msg["id"]?.GetValue<long>() ?? 0;
            var cmd = msg["cmd"]?.GetValue<string>() ?? "";

            switch (cmd)
            {
                case "ping":
                    Reply(new JsonObject {
                        ["id"] = id, ["ok"] = true,
                        ["file"] = _data.Name, ["path"] = _data.Path, ["writable"] = _data.Writable,
                    });
                    break;

                case "load":
                {
                    var node = _data.Read();
                    Reply(new JsonObject { ["id"] = id, ["ok"] = true, ["data"] = node?.DeepClone() });
                    break;
                }

                case "save":
                {
                    var data = msg["data"]?.DeepClone() as JsonObject;
                    if (data is null) { Fail(id, "저장할 내용이 없습니다"); break; }
                    var force = msg["force"]?.GetValue<bool>() ?? false;
                    var r = _data.Write(data, force);
                    if (r.Conflict) { Reply(new JsonObject { ["id"] = id, ["ok"] = true, ["conflict"] = true, ["fileRev"] = r.Rev }); break; }
                    if (!r.Ok) { Fail(id, r.Error ?? "저장 실패"); break; }
                    Reply(new JsonObject { ["id"] = id, ["ok"] = true, ["rev"] = r.Rev, ["saved"] = r.Saved });
                    break;
                }

                case "pickData":
                {
                    using var dlg = new OpenFileDialog {
                        Title = "어싸인 데이터 파일 고르기",
                        Filter = "어싸인 데이터 (*.json;*.js)|*.json;*.js|모든 파일 (*.*)|*.*",
                        InitialDirectory = System.IO.Path.GetDirectoryName(_data.Path) ?? AppContext.BaseDirectory,
                        CheckFileExists = false,
                    };
                    if (dlg.ShowDialog(this) != DialogResult.OK)
                    { Reply(new JsonObject { ["id"] = id, ["ok"] = true, ["changed"] = false }); break; }
                    _data.Use(dlg.FileName);
                    Reply(new JsonObject {
                        ["id"] = id, ["ok"] = true, ["changed"] = true,
                        ["file"] = _data.Name, ["path"] = _data.Path, ["writable"] = _data.Writable,
                    });
                    break;
                }

                default:
                    Fail(id, "모르는 요청: " + cmd);
                    break;
            }
        }
        catch (Exception ex)
        {
            Fail(id, ex.Message);
        }
    }

    private void Reply(JsonObject o) => _web.CoreWebView2.PostWebMessageAsJson(o.ToJsonString());
    private void Fail(long id, string error) =>
        Reply(new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = error });

    // ── 창 크기 기억 ────────────────────────────────────────────────────
    private static string StatePath => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NurseAssign", "window.json");

    private static Size WindowState_Load(out bool maximized)
    {
        maximized = false;
        try
        {
            if (!File.Exists(StatePath)) return new Size(1280, 900);
            var o = JsonNode.Parse(File.ReadAllText(StatePath)) as JsonObject;
            maximized = o?["max"]?.GetValue<bool>() ?? false;
            var w = o?["w"]?.GetValue<int>() ?? 1280;
            var h = o?["h"]?.GetValue<int>() ?? 900;
            return new Size(Math.Max(900, w), Math.Max(600, h));
        }
        catch (Exception) { return new Size(1280, 900); }
    }

    private void WindowState_Save()
    {
        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(StatePath)!);
            var sz = WindowState == FormWindowState.Normal ? Size : RestoreBounds.Size;
            var o = new JsonObject {
                ["w"] = sz.Width, ["h"] = sz.Height,
                ["max"] = WindowState == FormWindowState.Maximized,
            };
            File.WriteAllText(StatePath, o.ToJsonString(), new UTF8Encoding(false));
        }
        catch (Exception) { /* 창 크기는 못 남겨도 그만 */ }
    }
}
