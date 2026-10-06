using System.Text.Json;

namespace CaptureCodexSender.WinUI;

internal sealed class SenderSettings
{
    public string Host { get; set; } = "127.0.0.1";
    public int Port { get; set; } = 43127;
    public string PairingToken { get; set; } = "";
    public string CertificateSha256 { get; set; } = "";
    public string TargetSessionId { get; set; } = "";
    public uint HotkeyModifiers { get; set; } = 7;
    public uint HotkeyVirtualKey { get; set; } = 83;
    public uint SendHotkeyModifiers { get; set; } = 7;
    public uint SendHotkeyVirtualKey { get; set; } = 13;
    public uint VoiceHotkeyModifiers { get; set; } = 3;
    public uint VoiceHotkeyVirtualKey { get; set; } = 86;
    public uint VoiceStopHotkeyModifiers { get; set; } = 3;
    public uint VoiceStopHotkeyVirtualKey { get; set; } = 66;
    public uint? VoiceHoldHotkeyModifiers { get; set; }
    public uint? VoiceHoldHotkeyVirtualKey { get; set; }
    public uint RemoveHotkeyModifiers { get; set; } = 7;
    public uint RemoveHotkeyVirtualKey { get; set; } = 8;
    public bool VoiceHoldToTalk { get; set; }
    public bool StartInBackground { get; set; }
    public int SchemaVersion { get; set; } = 4;
    public IEnumerable<(string Action, InputChord Chord)> AllBindings() => new[] {
        ("capture", new InputChord(HotkeyModifiers, HotkeyVirtualKey)), ("send", new InputChord(SendHotkeyModifiers, SendHotkeyVirtualKey)),
        ("voice", new InputChord(VoiceHotkeyModifiers, VoiceHotkeyVirtualKey)), ("voiceStop", new InputChord(VoiceStopHotkeyModifiers, VoiceStopHotkeyVirtualKey)),
        ("remove", new InputChord(RemoveHotkeyModifiers, RemoveHotkeyVirtualKey)),
        ("voiceHold", new InputChord(VoiceHoldHotkeyModifiers ?? VoiceHotkeyModifiers, VoiceHoldHotkeyVirtualKey ?? VoiceHotkeyVirtualKey)) };
    public IEnumerable<(string Action, InputChord Chord)> Bindings() => AllBindings().Where(pair =>
        pair.Action == "voiceHold" ? VoiceHoldToTalk : pair.Action is "voice" or "voiceStop" ? !VoiceHoldToTalk : true);
    public void SetBinding(string action, InputChord chord)
    {
        switch (action) {
            case "capture": HotkeyModifiers = chord.Modifiers; HotkeyVirtualKey = chord.Key; break;
            case "send": SendHotkeyModifiers = chord.Modifiers; SendHotkeyVirtualKey = chord.Key; break;
            case "voice": VoiceHotkeyModifiers = chord.Modifiers; VoiceHotkeyVirtualKey = chord.Key; break;
            case "voiceStop": VoiceStopHotkeyModifiers = chord.Modifiers; VoiceStopHotkeyVirtualKey = chord.Key; break;
            case "voiceHold": VoiceHoldHotkeyModifiers = chord.Modifiers; VoiceHoldHotkeyVirtualKey = chord.Key; break;
            case "remove": RemoveHotkeyModifiers = chord.Modifiers; RemoveHotkeyVirtualKey = chord.Key; break;
            default: throw new InvalidOperationException("未知热键。");
        }
    }

    public void Validate(bool requirePairing = true)
    {
        if (string.IsNullOrWhiteSpace(Host) || Host.Contains('/') || Host.Contains('?')) throw new InvalidOperationException("地址只填写主机 IP 或域名，不包含协议和路径。");
        if (Port < 1024 || Port > 65535) throw new InvalidOperationException("端口应为 1024–65535。");
        CertificateSha256 = NormalizeFingerprint(CertificateSha256);
        if (requirePairing && (string.IsNullOrWhiteSpace(PairingToken) || CertificateSha256.Length != 64 || !CertificateSha256.All(Uri.IsHexDigit))) throw new InvalidOperationException("请填写配对令牌与完整证书指纹。");
        var keys = Bindings().Select(pair => pair.Chord).ToArray();
        if (keys.Any(k => !k.IsValid)) throw new InvalidOperationException("请选择键盘主键或鼠标按钮，可与 Ctrl、Alt、Shift、Win 组合。");
        if (keys.Distinct().Count() != keys.Length) throw new InvalidOperationException("快捷键不能重复。");
    }
    public static string NormalizeFingerprint(string value) => value.Replace(":", "").Replace(" ", "").Replace("-", "").ToUpperInvariant();
}

internal static class SenderSettingsStore
{
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };
    private static readonly string DirectoryPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CaptureCodex");
    private static readonly string PathName = Path.Combine(DirectoryPath, "settings.json");
    internal static string QueuePath { get; } = Path.Combine(DirectoryPath, "capture-queue");

    public static SenderSettings Load()
    {
        try {
            var settings = JsonSerializer.Deserialize<SenderSettings>(File.ReadAllText(PathName)) ?? new SenderSettings();
            settings.VoiceHoldHotkeyModifiers ??= settings.VoiceHotkeyModifiers;
            settings.VoiceHoldHotkeyVirtualKey ??= settings.VoiceHotkeyVirtualKey;
            settings.SchemaVersion = 4;
            return settings;
        }
        catch { return new SenderSettings(); }
    }

    public static void Save(SenderSettings settings)
    {
        Directory.CreateDirectory(DirectoryPath);
        File.WriteAllText(PathName + ".tmp", JsonSerializer.Serialize(settings, Options));
        File.Move(PathName + ".tmp", PathName, true);
    }
}
