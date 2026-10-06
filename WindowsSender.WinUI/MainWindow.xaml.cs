using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.System;
using System.Text.Json;
namespace CaptureCodexSender.WinUI;
public sealed partial class MainWindow : Window
{
    private readonly SenderController controller;
    private readonly Action exit;
    private bool exiting, refreshing, voiceModeReady, updatingVoiceMode;
    internal MainWindow(SenderController controller, Action exit)
    {
        InitializeComponent(); this.controller = controller; this.exit = exit;
        HostBox.Text = controller.Settings.Host; PortBox.Value = controller.Settings.Port; SessionBox.Text = controller.Settings.TargetSessionId;
        TokenBox.Password = controller.Settings.PairingToken; CertificateBox.Text = controller.Settings.CertificateSha256;
        HoldToTalkSwitch.IsOn = controller.Settings.VoiceHoldToTalk; BackgroundSwitch.IsOn = controller.Settings.StartInBackground;
        voiceModeReady = true;
        controller.Changed += Refresh;
        AppWindow.Closing += (_, args) => { if (!exiting) { args.Cancel = true; controller.CancelRecording(); AppWindow.Hide(); } };
        Closed += (_, _) => controller.Changed -= Refresh;
        Refresh();
    }
    internal void CloseForExit() { exiting = true; Close(); }
    private async void Refresh()
    {
        StatusBar.Title = controller.HasError ? "操作未完成" : "WindowsSender"; StatusBar.Message = controller.Status;
        StatusBar.Severity = controller.HasError ? InfoBarSeverity.Error : InfoBarSeverity.Informational;
        QueueText.Text = $"本地待发送 {controller.Service.PendingCount} 张 · {(controller.Service.VoiceActive ? "录音 / 待发送" : "未录音")}";
        UpdateVoiceMode();
        foreach (var (action, chord) in controller.Settings.AllBindings()) {
            var button = action switch { "capture" => CaptureHotkeyButton, "send" => SendHotkeyButton, "voice" => VoiceHotkeyButton, "voiceStop" => VoiceStopHotkeyButton, "voiceHold" => VoiceHoldHotkeyButton, _ => RemoveHotkeyButton };
            var label = action switch { "capture" => "截图 / 暂存", "send" => "发送截图", "voice" => "开始录音", "voiceStop" => "停止并发送", "voiceHold" => "按住说话热键", _ => "移除最近一张" };
            button.Content = action == controller.RecordingAction ? "正在监听：请按键盘组合或鼠标按钮，Esc 取消" : label + "：" + Format(chord);
        }
        if (refreshing) return; refreshing = true;
        try { CaptureQueueList.ItemsSource = (await controller.Service.GetQueuedCapturesAsync()).Select(c => new CapturePreview(c.Id, c.Monitor, new BitmapImage(new Uri(c.ImagePath)))).ToList(); }
        catch (Exception error) { QueueText.Text += " · " + error.Message; }
        finally { refreshing = false; }
    }
    private async void SaveClick(object sender, RoutedEventArgs args)
    {
        try {
            var next = JsonSerializer.Deserialize<SenderSettings>(JsonSerializer.Serialize(controller.Settings))!;
            next.Host = HostBox.Text.Trim(); if (!double.IsFinite(PortBox.Value) || PortBox.Value != Math.Truncate(PortBox.Value)) throw new InvalidOperationException("请填写有效整数端口。");
            next.Port = (int)PortBox.Value; next.TargetSessionId = SessionBox.Text.Trim(); next.PairingToken = TokenBox.Password.Trim(); next.CertificateSha256 = CertificateBox.Text.Trim();
            next.VoiceHoldToTalk = HoldToTalkSwitch.IsOn; next.StartInBackground = BackgroundSwitch.IsOn;
            await controller.ApplySettings(next);
        } catch (Exception error) { controller.Report(error.Message, true); }
    }
    private void BackgroundClick(object sender, RoutedEventArgs args) { controller.CancelRecording(); AppWindow.Hide(); }
    private void ExitClick(object sender, RoutedEventArgs args) => exit();
    private void CaptureHotkeyClick(object sender, RoutedEventArgs args) => controller.BeginRecording("capture");
    private void SendHotkeyClick(object sender, RoutedEventArgs args) => controller.BeginRecording("send");
    private void VoiceHotkeyClick(object sender, RoutedEventArgs args) => controller.BeginRecording("voice");
    private void VoiceStopHotkeyClick(object sender, RoutedEventArgs args) => controller.BeginRecording("voiceStop");
    private void VoiceHoldHotkeyClick(object sender, RoutedEventArgs args) => controller.BeginRecording("voiceHold");
    private void UpdateVoiceMode()
    {
        updatingVoiceMode = true;
        HoldToTalkSwitch.IsOn = controller.Settings.VoiceHoldToTalk;
        VoiceHotkeyButton.Visibility = VoiceStopHotkeyButton.Visibility = HoldToTalkSwitch.IsOn ? Visibility.Collapsed : Visibility.Visible;
        VoiceHoldHotkeyButton.Visibility = HoldToTalkSwitch.IsOn ? Visibility.Visible : Visibility.Collapsed;
        VoiceHoldInputText.Visibility = VoiceHoldHotkeyButton.Visibility;
        VoiceHoldInputText.Text = controller.HoldInputStatus;
        updatingVoiceMode = false;
    }
    private void HoldToTalkToggled(object sender, RoutedEventArgs args)
    {
        if (!voiceModeReady || updatingVoiceMode) return;
        try { controller.SetVoiceMode(HoldToTalkSwitch.IsOn); }
        catch (Exception error) { controller.Report(error.Message, true); }
        UpdateVoiceMode();
    }
    private void RemoveHotkeyClick(object sender, RoutedEventArgs args) => controller.BeginRecording("remove");
    private void CaptureClick(object sender, RoutedEventArgs args) => controller.Run(async () => { await controller.Service.CaptureDisplaysAsync(); });
    private void SendClick(object sender, RoutedEventArgs args) => controller.Run(async () => { await controller.Service.SendPendingAsync(); });
    private void RemoveAllClick(object sender, RoutedEventArgs args) => controller.Run(async () => { await controller.Service.RemoveCapturesAsync(all: true); });
    private void RemoveCaptureClick(object sender, RoutedEventArgs args) { if (sender is Button { Tag: string id }) controller.Run(async () => { await controller.Service.RemoveCapturesAsync(new[] { id }); }); }
    private void VoiceStartClick(object sender, RoutedEventArgs args) => controller.Voice(true);
    private void VoiceStopClick(object sender, RoutedEventArgs args) => controller.Voice(false);
    private void VoiceCancelClick(object sender, RoutedEventArgs args) => controller.Run(controller.Service.CancelVoiceAsync);
    private void TestConnectionClick(object sender, RoutedEventArgs args) => controller.Run(async () => {
        var status = await controller.Service.GetStatusAsync(); controller.Report($"连接成功 · Codex {status.Connection} · 登录 {status.Auth} · 目标 {status.Target?.SessionId ?? "未打开会话"} · 客户端暂存 {status.PendingCaptures} 张");
    });
    private static string Format(InputChord chord)
    {
        var parts = new List<string>(); if ((chord.Modifiers & 2) != 0) parts.Add("Ctrl"); if ((chord.Modifiers & 1) != 0) parts.Add("Alt");
        if ((chord.Modifiers & 4) != 0) parts.Add("Shift"); if ((chord.Modifiers & 8) != 0) parts.Add("Win");
        parts.Add(chord.Key switch { 1 => "鼠标左键", 2 => "鼠标右键", 4 => "鼠标中键", 5 => "鼠标侧键 1", 6 => "鼠标侧键 2", _ => ((VirtualKey)chord.Key).ToString() });
        return string.Join(" + ", parts);
    }
    public sealed record CapturePreview(string Id, string Monitor, BitmapImage Image);
}
