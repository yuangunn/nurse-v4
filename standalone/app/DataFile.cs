using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AssignApp;

/// <summary>
/// 데이터 파일(JSON) 읽기·쓰기. 브라우저를 거치지 않고 네이티브로 직접 다룬다.
///
/// 저장 규칙은 브라우저 방식과 같다:
///  · 임시 파일에 쓴 뒤 교체 — 저장 중 전원이 나가도 원본이 깨지지 않는다.
///  · 다른 PC가 먼저 저장했으면(파일 rev가 더 큼) 덮어쓰지 않고 알려 준다.
///  · 파일을 읽을 수 없으면 절대 덮어쓰지 않는다 (깨진/잠긴 파일 보호).
/// </summary>
public sealed class DataFile
{
    private const string ConfigName = "assign.ini";     // data=<경로> 한 줄
    private const string DefaultName = "assign-data.json";

    public string Path { get; private set; }

    public DataFile(string? overridePath = null)
    {
        Path = overridePath ?? Resolve();
    }

    public string Name => System.IO.Path.GetFileName(Path);

    public bool Writable
    {
        get
        {
            try
            {
                var dir = System.IO.Path.GetDirectoryName(Path);
                if (string.IsNullOrEmpty(dir)) return false;
                if (!Directory.Exists(dir)) return false;
                // 실제로 쓸 수 있는지 확인 — 권한만 보면 NAS에서 틀리는 경우가 있다
                var probe = System.IO.Path.Combine(dir, ".assign-write-test");
                File.WriteAllText(probe, "");
                File.Delete(probe);
                return true;
            }
            catch (Exception) { return false; }
        }
    }

    public void Use(string path) => Path = path;

    /// <summary>exe 옆 assign.ini 의 data= 경로 → 없으면 exe 옆 assign-data.json</summary>
    private static string Resolve()
    {
        var baseDir = AppContext.BaseDirectory;
        var cfg = System.IO.Path.Combine(baseDir, ConfigName);
        if (File.Exists(cfg))
        {
            try
            {
                foreach (var line in File.ReadAllLines(cfg, Encoding.UTF8))
                {
                    var i = line.IndexOf('=');
                    if (i <= 0) continue;
                    if (!line[..i].Trim().Equals("data", StringComparison.OrdinalIgnoreCase)) continue;
                    var v = Environment.ExpandEnvironmentVariables(line[(i + 1)..].Trim().Trim('"'));
                    if (v.Length == 0) continue;
                    return System.IO.Path.IsPathRooted(v) ? v : System.IO.Path.Combine(baseDir, v);
                }
            }
            catch (IOException) { /* 설정을 못 읽으면 기본값으로 */ }
        }
        return System.IO.Path.Combine(baseDir, DefaultName);
    }

    /// <summary>파일 내용을 JSON 노드로. 없으면 null.</summary>
    public JsonNode? Read()
    {
        if (!File.Exists(Path)) return null;
        var txt = File.ReadAllText(Path, Encoding.UTF8).Trim();
        if (txt.Length == 0) return null;
        // 브라우저용 자동 열림 파일(window.__ASSIGN_DATA={...};)도 그대로 읽는다
        if (txt.StartsWith("window.", StringComparison.Ordinal))
        {
            var eq = txt.IndexOf('=');
            if (eq < 0) return null;
            txt = txt[(eq + 1)..].TrimEnd().TrimEnd(';');
        }
        return JsonNode.Parse(txt);
    }

    public sealed record SaveResult(bool Ok, bool Conflict, long Rev, string Saved, string? Error);

    public SaveResult Write(JsonNode data, bool force)
    {
        JsonNode? cur;
        try { cur = Read(); }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return new SaveResult(false, false, 0, "", "파일을 읽을 수 없어 저장을 보류했습니다: " + e.Message);
        }

        long fileRev = 0;
        if (cur?["rev"] is JsonValue rv && rv.TryGetValue<long>(out var r)) fileRev = r;
        long mine = 0;
        if (data["rev"] is JsonValue mv && mv.TryGetValue<long>(out var m)) mine = m;
        if (fileRev > mine && !force)
            return new SaveResult(false, true, fileRev, "", null);

        var rev = Math.Max(fileRev, mine) + 1;
        var saved = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss");
        data["rev"] = rev;
        data["saved"] = saved;

        var body = data.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        if (Path.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            body = "window.__ASSIGN_DATA=" + body + ";\n";

        try
        {
            var dir = System.IO.Path.GetDirectoryName(Path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var tmp = Path + ".tmp";
            File.WriteAllText(tmp, body, new UTF8Encoding(false));
            // 원자적 교체 — NAS(SMB)에서 Replace 가 막히면 삭제 후 이동으로
            if (File.Exists(Path))
            {
                try { File.Replace(tmp, Path, null); }
                catch (IOException) { File.Delete(Path); File.Move(tmp, Path); }
            }
            else File.Move(tmp, Path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new SaveResult(false, false, 0, "", "저장하지 못했습니다: " + e.Message);
        }
        return new SaveResult(true, false, rev, saved, null);
    }
}
