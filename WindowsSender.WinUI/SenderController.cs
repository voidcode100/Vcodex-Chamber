using Microsoft.UI.Dispatching;
using System.Text.Json;
namespace CaptureCodexSender.WinUI;

/// Owns the sender independently from the settings window, including headless mode.
internal sealed class SenderController : IAsyncDisposable
{
    private readonly DispatcherQueue dispatcher;
    private readonly CancellationTokenSource lifetime = new();
    private readonly object voiceSync = new();
    private Task voiceTail = Task.CompletedTask;
    private int voicePending;
    private readonly Task retryLoop;
    private GlobalHotkeyService hotkeys = null!;
    public SenderSettings Settings { get; private set; }
    public CaptureService Service { get; private set; }
    public string Status { get; private set; } = "准备连接";
    public bool HasError { get; private set; }
    public bool IsRecordingHotkey { get; private set; }
    public string? RecordingAction { get; private set; }
    public string HoldInputStatus { get; private set; } = "等待按住说话热键";
    public event Action? Changed;
    public SenderController(DispatcherQueue dispatcher)
    {
        this.dispatcher = dispatcher; Settings = SenderSettingsStore.Load(); Service = CreateService(); StartHotkeys();
        retryLoop = RetryLoop();
    }
    private CaptureService CreateService() { var service = new CaptureService(Settings); service.StatusChanged += text => Report(text); return service; }
    public void Report(string message, bool error = false) { dispatcher.TryEnqueue(() => { Status = message; HasError = error; Changed?.Invoke(); }); }
    public void Run(Func<Task> action) => _ = Task.Run(async () => { try { await action(); } catch (Exception error) { Report(error.Message, true); } });
    public void Voice(bool start, bool onlyIfActive = false)
    {
        lock (voiceSync) {
            Interlocked.Increment(ref voicePending);
            voiceTail = voiceTail.ContinueWith(async _ => {
                try {
                    if (start) await Service.StartVoiceAsync(); else if (!onlyIfActive || Service.VoiceActive) await Service.StopVoiceAsync();
                }
                catch (Exception error) {
                    Report(error.Message, true);
                }
                finally { Interlocked.Decrement(ref voicePending); }
            }, TaskScheduler.Default).Unwrap();
        }
    }
    public async Task ApplySettings(SenderSettings next)
    {
        if (Service.VoiceActive || Volatile.Read(ref voicePending) > 0) throw new InvalidOperationException("请先停止或丢弃录音，再修改设置。");
        next.Validate(requirePairing: !string.IsNullOrWhiteSpace(next.PairingToken) || !string.IsNullOrWhiteSpace(next.CertificateSha256)); hotkeys.Dispose(); await Service.DisposeAsync();
        Settings = next; SenderSettingsStore.Save(Settings); Service = CreateService(); StartHotkeys(); Changed?.Invoke();
    }
    public void BeginRecording(string action)
    {
        if (Service.VoiceActive || Volatile.Read(ref voicePending) > 0) { Report("请先结束录音再设置热键。", true); return; }
        IsRecordingHotkey = true; RecordingAction = action; hotkeys.BeginRecording(action);
        Report("请按键盘组合或鼠标按钮（支持侧键），Esc 取消；录制期间暂停其他热键。");
    }
    public void CancelRecording() { hotkeys.CancelRecording(); }
    public void SetVoiceMode(bool holdToTalk)
    {
        if (Settings.VoiceHoldToTalk == holdToTalk) return;
        if (Service.VoiceActive || Volatile.Read(ref voicePending) > 0) throw new InvalidOperationException("请先结束录音再切换录音模式。");
        var next = JsonSerializer.Deserialize<SenderSettings>(JsonSerializer.Serialize(Settings))!;
        next.VoiceHoldToTalk = holdToTalk; next.Validate(false);
        CancelRecording(); SenderSettingsStore.Save(next); Settings = next;
        StartHotkeys(); Changed?.Invoke();
    }
    private void Recorded(string action, InputChord? chord) => dispatcher.TryEnqueue(() => {
        IsRecordingHotkey = false; RecordingAction = null;
        if (chord is null) { Report("热键录制已取消。"); return; }
        try {
            var next = JsonSerializer.Deserialize<SenderSettings>(JsonSerializer.Serialize(Settings))!;
            next.SetBinding(action, chord.Value); next.Validate(false);
            Settings.SetBinding(action, chord.Value); SenderSettingsStore.Save(Settings); StartHotkeys(); Changed?.Invoke();
        } catch (Exception error) { BeginRecording(action); Report(error.Message + " 请重新按键，或 Esc 取消。", true); }
    });
    private void StartHotkeys()
    {
        hotkeys?.Dispose();
        try {
            hotkeys = new GlobalHotkeyService(Settings);
            hotkeys.Recorded += Recorded;
            hotkeys.Pressed += action => {
                switch (action) {
                    case "capture": Run(async () => { await Service.CaptureDisplaysAsync(); }); break;
                    case "send": Run(async () => { await Service.SendPendingAsync(); }); break;
                    case "remove": Run(async () => { await Service.RemoveCapturesAsync(); }); break;
                    case "voice": Voice(true); break;
                    case "voiceHold": UpdateHoldInputStatus("热键已按下，正在请求客户端录音；松开后停止并发送"); Voice(true); break;
                    case "voiceStop": Voice(false); break;
                    case "voiceRelease": UpdateHoldInputStatus("热键已松开，等待客户端停止、转写并发送"); Voice(false, true); break;
                }
            };
            if (!hotkeys.Start()) Report("热键注册失败：" + hotkeys.RegistrationError + "，请更换组合键。", true);
            else Report($"{Settings.Bindings().Count()} 个热键已启用；" + (Settings.VoiceHoldToTalk ? "按住录音，松开转写并发送。" : "录音使用独立开始/停止键。"));
        } catch (Exception error) { Report(error.Message, true); }
    }
    private void UpdateHoldInputStatus(string message) => dispatcher.TryEnqueue(() => { HoldInputStatus = message; Changed?.Invoke(); });
    private async Task RetryLoop()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        try {
            while (await timer.WaitForNextTickAsync(lifetime.Token)) {
                if (IsRecordingHotkey) continue;
                try { await Service.StagePendingAsync(); } catch (Exception error) { if (Service.PendingCount > 0) Report(error.Message, true); }
                dispatcher.TryEnqueue(() => Changed?.Invoke());
            }
        } catch (OperationCanceledException) { }
    }
    public async ValueTask DisposeAsync()
    {
        lifetime.Cancel(); hotkeys?.Dispose();
        await Task.WhenAny(voiceTail, Task.Delay(2000));
        if (Service.VoiceActive) await Task.WhenAny(Service.CancelVoiceAsync(), Task.Delay(3000));
        await Service.DisposeAsync(); await retryLoop; lifetime.Dispose();
    }
}
