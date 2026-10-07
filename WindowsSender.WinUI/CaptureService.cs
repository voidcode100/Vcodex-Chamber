using System.Drawing;
using System.Drawing.Imaging;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;

namespace CaptureCodexSender.WinUI;

internal sealed class CaptureService : IAsyncDisposable
{
    private readonly SenderSettings settings;
    private readonly HttpClient http;
    private readonly string queuePath;
    private readonly SemaphoreSlim capturesGate = new(1), voiceGate = new(1);
    private readonly CancellationTokenSource lifetime = new();
    private string? voiceSession, stopRequestId, startRequestId;
    private bool voiceActive;
    public bool VoiceActive => voiceActive;
    public event Action<string>? StatusChanged;
    private static bool IsCaptureMetadata(string path) => !Path.GetFileName(path).StartsWith("send-") && !Path.GetFileName(path).StartsWith("drop-");
    public int PendingCount => Directory.Exists(queuePath) ? Directory.EnumerateFiles(queuePath, "*.json").Count(IsCaptureMetadata) : 0;

    public CaptureService(SenderSettings settings, string? queuePath = null)
    {
        this.settings = settings;
        this.queuePath = queuePath ?? SenderSettingsStore.QueuePath;
        var handler = new HttpClientHandler { UseProxy = false, ServerCertificateCustomValidationCallback = (_, certificate, _, _) => ValidateCertificate(certificate?.GetRawCertData()) };
        http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(90) };
    }

    public async Task<int> CaptureDisplaysAsync()
    {
        await capturesGate.WaitAsync(lifetime.Token);
        try
        {
            Directory.CreateDirectory(queuePath);
            var batchId = Guid.NewGuid().ToString("N");
            var count = 0;
            foreach (var display in EnumerateDisplays())
            {
                using var bitmap = new Bitmap(display.Bounds.Width, display.Bounds.Height, PixelFormat.Format32bppArgb);
                using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(display.Bounds.Location, Point.Empty, display.Bounds.Size, CopyPixelOperation.SourceCopy);
                var id = Guid.NewGuid().ToString("N");
                var imagePath = Path.Combine(queuePath, $"{id}.png");
                bitmap.Save(imagePath + ".tmp", ImageFormat.Png); File.Move(imagePath + ".tmp", imagePath, true);
                await WriteJson(Path.Combine(queuePath, $"{id}.json"), new QueuedCapture(id, display.Name, imagePath, batchId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + count, settings.TargetSessionId));
                count++;
            }
            StatusChanged?.Invoke($"已采集 {count} 张，正在加入客户端会话框…");
            try { await StageCoreAsync(lifetime.Token); }
            catch (Exception error) { StatusChanged?.Invoke($"截图保存在本地，稍后重试上传：{error.Message}"); }
            return count;
        }
        finally { capturesGate.Release(); }
    }

    public async Task StagePendingAsync()
    {
        if (!await capturesGate.WaitAsync(0, lifetime.Token)) return;
        try { if (Directory.Exists(queuePath) && Directory.EnumerateFiles(queuePath, "*.json").Any()) await StageCoreAsync(lifetime.Token); }
        finally { capturesGate.Release(); }
    }
    private async Task<List<(string Path, QueuedCapture Capture)>> ReadQueue(CancellationToken token)
    {
        var entries = new List<(string, QueuedCapture)>();
        if (!Directory.Exists(queuePath)) return entries;
        foreach (var file in Directory.EnumerateFiles(queuePath, "*.json").Where(IsCaptureMetadata))
        {
            var capture = JsonSerializer.Deserialize<QueuedCapture>(await File.ReadAllTextAsync(file, token));
            if (capture is null || !File.Exists(capture.ImagePath)) throw new InvalidOperationException("截图队列文件不完整，请检查本地队列。");
            entries.Add((file, capture));
        }
        return entries.OrderBy(e => e.Item2.CreatedAt == 0 ? new DateTimeOffset(File.GetCreationTimeUtc(e.Item1)).ToUnixTimeMilliseconds() : e.Item2.CreatedAt).ThenBy(e => e.Item2.Id).ToList();
    }
    private async Task StageCoreAsync(CancellationToken token)
    {
        settings.Validate();
        await FlushRemovals(token);
        var entries = await ReadQueue(token);
        string? activeTarget = null;
        foreach (var (metadataPath, queued) in entries)
        {
            var capture = queued;
            if (string.IsNullOrWhiteSpace(capture.SessionId))
            {
                activeTarget ??= (await GetStatusAsync(token)).Target?.SessionId;
                if (string.IsNullOrWhiteSpace(activeTarget)) throw new InvalidOperationException("客户端没有当前会话，请先打开会话。");
                capture = capture with { SessionId = activeTarget };
                await WriteJson(metadataPath, capture);
            }
            using var request = Request(HttpMethod.Post, "/v1/capture");
            request.Headers.Add("X-Capture-Id", capture.Id);
            request.Headers.Add("X-Capture-Batch-Id", string.IsNullOrWhiteSpace(capture.BatchId) ? capture.Id : capture.BatchId);
            request.Headers.Add("X-Target-Session", capture.SessionId);
            request.Headers.Add("X-Monitor-Name", capture.Monitor);
            request.Content = new ByteArrayContent(await File.ReadAllBytesAsync(capture.ImagePath, token));
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("image/png");
            using var response = await http.SendAsync(request, token);
            var body = await ReadResponse(response, token);
            if (body.TryGetProperty("sessionId", out var session) && session.GetString() != capture.SessionId) throw new InvalidOperationException("客户端返回的截图会话与预期不符。");
            if (body.TryGetProperty("discarded", out var discarded) && discarded.GetBoolean()) {
                DeleteLocal(metadataPath, capture); await RemoveSendIntents(new[] { capture.Id });
            }
            else if (body.TryGetProperty("sent", out var sent) && sent.GetBoolean())
            {
                var hasIntent = Directory.EnumerateFiles(queuePath, "send-*.json").Any();
                if (!hasIntent) { File.Delete(capture.ImagePath); File.Delete(metadataPath); }
            }
        }
        if (entries.Count > 0) StatusChanged?.Invoke($"{PendingCount} 张截图已在客户端会话框暂存，按发送快捷键提交。");
    }
    public async Task<List<QueuedCapture>> GetQueuedCapturesAsync()
    {
        await capturesGate.WaitAsync(lifetime.Token);
        try { return (await ReadQueue(lifetime.Token)).Select(entry => entry.Capture).ToList(); }
        finally { capturesGate.Release(); }
    }
    public async Task<int> RemoveCapturesAsync(string[]? ids = null, bool all = false)
    {
        await capturesGate.WaitAsync(lifetime.Token);
        try {
            var entries = await ReadQueue(lifetime.Token);
            var selected = ids is not null ? entries.Where(e => ids.Contains(e.Capture.Id)).ToList() : all ? entries : entries.TakeLast(1).ToList();
            foreach (var group in selected.GroupBy(e => e.Capture.SessionId)) {
                var captureIds = group.Select(e => e.Capture.Id).ToArray();
                if (!string.IsNullOrWhiteSpace(group.Key)) {
                    var intentPath = Path.Combine(queuePath, $"drop-{Guid.NewGuid():N}.json");
                    var intent = new RemoveIntent(captureIds, group.Key);
                    await WriteJson(intentPath, intent);
                    try { await SendRemoval(intent, lifetime.Token); File.Delete(intentPath); }
                    catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { throw; }
                    catch (Exception error) when (!lifetime.IsCancellationRequested && (error is HttpRequestException or TaskCanceledException)) {
                        var hasSubmission = Directory.EnumerateFiles(queuePath, "send-*.json").Any();
                        if (hasSubmission) { File.Delete(intentPath); throw new InvalidOperationException("提交状态未确认，请恢复连接后再移除。", error); }
                        StatusChanged?.Invoke("本地已移除，连接恢复后同步客户端删除。");
                    }
                    catch { File.Delete(intentPath); throw; }
                }
                foreach (var entry in group) DeleteLocal(entry.Path, entry.Capture);
                await RemoveSendIntents(captureIds);
            }
            StatusChanged?.Invoke($"已移除 {selected.Count} 张截图，本地剩余 {PendingCount} 张。"); return selected.Count;
        } finally { capturesGate.Release(); }
    }
    private void DeleteLocal(string metadata, QueuedCapture capture)
    {
        var image = Path.GetFullPath(capture.ImagePath);
        if (!image.StartsWith(Path.GetFullPath(queuePath) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("截图文件不在队列目录。");
        File.Delete(image); File.Delete(metadata);
    }
    private async Task RemoveSendIntents(string[] ids)
    {
        foreach (var path in Directory.EnumerateFiles(queuePath, "send-*.json")) {
            var intent = JsonSerializer.Deserialize<SendIntent>(await File.ReadAllTextAsync(path, lifetime.Token));
            if (intent?.CaptureIds.Any(ids.Contains) == true) File.Delete(path);
        }
    }
    private async Task SendRemoval(RemoveIntent intent, CancellationToken token)
    {
        using var request = Request(HttpMethod.Post, "/v1/capture/remove");
        request.Content = new StringContent(JsonSerializer.Serialize(new { captureIds = intent.CaptureIds, sessionId = intent.SessionId }), Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request, token); await ReadResponse(response, token);
    }
    private async Task FlushRemovals(CancellationToken token)
    {
        if (!Directory.Exists(queuePath)) return;
        foreach (var path in Directory.EnumerateFiles(queuePath, "drop-*.json")) {
            var intent = JsonSerializer.Deserialize<RemoveIntent>(await File.ReadAllTextAsync(path, token))!;
            await SendRemoval(intent, token); File.Delete(path);
        }
    }
    public async Task<int> SendPendingAsync(CancellationToken cancellationToken = default)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lifetime.Token);
        await capturesGate.WaitAsync(linked.Token);
        try
        {
            await StageCoreAsync(linked.Token);
            var entries = await ReadQueue(linked.Token);
            var sent = 0;
            // A persisted intent keeps the same ID and image set after a timeout.
            foreach (var group in entries.GroupBy(e => e.Capture.SessionId))
            {
                var intentPath = Path.Combine(queuePath, $"send-{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(group.Key))).Substring(0, 20)}.json");
                var intent = File.Exists(intentPath) ? JsonSerializer.Deserialize<SendIntent>(await File.ReadAllTextAsync(intentPath, linked.Token))! : new SendIntent(Guid.NewGuid().ToString("N"), group.Select(e => e.Capture.Id).ToArray(), group.Key);
                await WriteJson(intentPath, intent);
                using var request = Request(HttpMethod.Post, "/v1/capture/send");
                request.Content = new StringContent(JsonSerializer.Serialize(new { requestId = intent.RequestId, captureIds = intent.CaptureIds, sessionId = intent.SessionId }), Encoding.UTF8, "application/json");
                StatusChanged?.Invoke($"正在发送 {intent.CaptureIds.Length} 张截图…");
                using var response = await http.SendAsync(request, linked.Token);
                await ReadResponse(response, linked.Token);
                foreach (var entry in group.Where(e => intent.CaptureIds.Contains(e.Capture.Id))) { File.Delete(entry.Capture.ImagePath); File.Delete(entry.Path); sent++; }
                File.Delete(intentPath);
            }
            StatusChanged?.Invoke($"已发送 {sent} 张截图，Codex 正在处理。" );
            return sent;
        }
        finally { capturesGate.Release(); }
    }
    public async Task<ReceiverStatus> GetStatusAsync(CancellationToken token = default)
    {
        settings.Validate();
        using var request = Request(HttpMethod.Get, "/v1/status");
        using var response = await http.SendAsync(request, token);
        var body = await ReadResponse(response, token);
        return JsonSerializer.Deserialize<ReceiverStatus>(body.GetRawText(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    }

    public async Task StartVoiceAsync()
    {
        await voiceGate.WaitAsync(lifetime.Token);
        try
        {
            // A failed stop retains its request ID for an explicit stop/retry.
            // A new key-down must reach the client instead of mistaking that
            // retained recording for an active microphone. The client decides
            // whether it can discard a failed transcription safely.
            if (voiceActive && stopRequestId is null) { StatusChanged?.Invoke("客户端已经在录音，按停止快捷键转写并发送。"); return; }
            settings.Validate(); startRequestId ??= Guid.NewGuid().ToString("N");
            StatusChanged?.Invoke("正在请求客户端麦克风…");
            var ack = await VoiceControl("start", startRequestId, string.IsNullOrWhiteSpace(settings.TargetSessionId) ? null : settings.TargetSessionId);
            voiceSession = ack.TryGetProperty("sessionId", out var session) ? session.GetString() : null;
            voiceActive = true; startRequestId = null; stopRequestId = null;
            StatusChanged?.Invoke("客户端正在录音，按停止快捷键转写并自动发送。");
        }
        finally { voiceGate.Release(); }
    }
    public async Task<string> StopVoiceAsync()
    {
        await voiceGate.WaitAsync(lifetime.Token);
        try
        {
            settings.Validate(); stopRequestId ??= Guid.NewGuid().ToString("N");
            StatusChanged?.Invoke("录音已停止，正在转写并发送，请稍候…");
            var ack = await VoiceControl("stop", stopRequestId, voiceSession);
            voiceActive = false; voiceSession = null; stopRequestId = null; startRequestId = null;
            var text = ack.TryGetProperty("transcript", out var transcript) ? transcript.GetString() ?? "" : "";
            StatusChanged?.Invoke(string.IsNullOrWhiteSpace(text) ? "没有待发送录音。" : "语音已转成文字并发送到会话，Codex 正在处理。");
            return text;
        }
        finally { voiceGate.Release(); }
    }
    public async Task CancelVoiceAsync()
    {
        await voiceGate.WaitAsync(lifetime.Token);
        try { await VoiceControl("cancel", Guid.NewGuid().ToString("N"), voiceSession); voiceActive = false; voiceSession = null; stopRequestId = null; startRequestId = null; StatusChanged?.Invoke("已丢弃客户端录音。"); }
        finally { voiceGate.Release(); }
    }
    private async Task<JsonElement> VoiceControl(string action, string requestId, string? sessionId)
    {
        for (var attempt = 0; ; attempt++)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(100));
            using var socket = new ClientWebSocket();
            socket.Options.Proxy = null;
            socket.Options.SetRequestHeader("Authorization", $"Bearer {settings.PairingToken}");
            socket.Options.RemoteCertificateValidationCallback = (_, cert, _, _) => ValidateCertificate(cert?.GetRawCertData());
            try
            {
                await socket.ConnectAsync(new UriBuilder(Uri.UriSchemeWss, settings.Host, settings.Port, "/v1/voice").Uri, timeout.Token);
                var payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { type = action, requestId, sessionId }));
                await socket.SendAsync(new ArraySegment<byte>(payload), WebSocketMessageType.Text, true, timeout.Token);
                var buffer = new byte[4096]; using var message = new MemoryStream();
                while (true)
                {
                    var frame = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), timeout.Token);
                    if (frame.MessageType == WebSocketMessageType.Close) throw new WebSocketException("客户端在确认前断开连接。");
                    message.Write(buffer, 0, frame.Count);
                    if (message.Length > 128 * 1024) throw new InvalidOperationException("录音响应过大。");
                    if (!frame.EndOfMessage) continue;
                    using var doc = JsonDocument.Parse(message.ToArray()); message.SetLength(0);
                    var body = doc.RootElement;
                    if (!body.TryGetProperty("requestId", out var id) || id.GetString() != requestId) continue;
                    if (body.GetProperty("type").GetString() == "error") throw new InvalidOperationException(body.GetProperty("message").GetString());
                    if (body.GetProperty("type").GetString() == "ack") return body.Clone();
                }
            }
            catch (Exception error) when (attempt == 0 && !lifetime.IsCancellationRequested && (error is WebSocketException or OperationCanceledException)) { /* reconnect with the same request id */ }
        }
    }
    private HttpRequestMessage Request(HttpMethod method, string path)
    {
        var request = new HttpRequestMessage(method, new UriBuilder(Uri.UriSchemeHttps, settings.Host, settings.Port, path).Uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.PairingToken); return request;
    }
    private static async Task<JsonElement> ReadResponse(HttpResponseMessage response, CancellationToken token)
    {
        var text = await response.Content.ReadAsStringAsync(token);
        using var doc = JsonDocument.Parse(text);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(doc.RootElement.TryGetProperty("error", out var error) ? error.GetString() : $"客户端返回 HTTP {(int)response.StatusCode}。");
        return doc.RootElement.Clone();
    }
    private static async Task WriteJson<T>(string path, T value) { await File.WriteAllTextAsync(path + ".tmp", JsonSerializer.Serialize(value)); File.Move(path + ".tmp", path, true); }
    private bool ValidateCertificate(byte[]? cert)
    {
        try { return cert is not null && CryptographicOperations.FixedTimeEquals(SHA256.HashData(cert), Convert.FromHexString(SenderSettings.NormalizeFingerprint(settings.CertificateSha256))); }
        catch { return false; }
    }
    public async ValueTask DisposeAsync() { lifetime.Cancel(); await capturesGate.WaitAsync(); await voiceGate.WaitAsync(); http.Dispose(); capturesGate.Release(); voiceGate.Release(); lifetime.Dispose(); }
    internal sealed record QueuedCapture(string Id, string Monitor, string ImagePath, string BatchId = "", long CreatedAt = 0, string SessionId = "");
    private sealed record SendIntent(string RequestId, string[] CaptureIds, string SessionId);
    private sealed record RemoveIntent(string[] CaptureIds, string SessionId);
    internal sealed record ReceiverStatus(TargetInfo? Target, int PendingCaptures, bool VoiceActive, string? Connection, string? Auth, JsonElement Voice);
    internal sealed record TargetInfo(string? Mode, string? SessionId);
    private sealed record Display(string Name, Rectangle Bounds);
    private static IEnumerable<Display> EnumerateDisplays()
    {
        var displays = new List<Display>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (monitor, _, _, _) => { var info = new MonitorInfo { cbSize = Marshal.SizeOf<MonitorInfo>() }; if (GetMonitorInfo(monitor, ref info)) displays.Add(new Display(info.szDevice, Rectangle.FromLTRB(info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right, info.rcMonitor.Bottom))); return true; }, IntPtr.Zero);
        if (displays.Count == 0) throw new InvalidOperationException("没有可采集的显示器。");
        return displays;
    }
    // Win32 RECT stores right/bottom coordinates, not System.Drawing width/height.
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct MonitorInfo { public int cbSize; public Rect rcMonitor; public Rect rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
}
