namespace CaptureCodexSender.WinUI;
internal readonly record struct InputChord(uint Modifiers, uint Key)
{
    public bool IsMouse => Key is 1 or 2 or 4 or 5 or 6;
    public bool IsValid => Modifiers <= 15 && Key is > 0 and < 255 && !IsModifier(Key) && Key != 27;
    public static bool IsModifier(uint key) => key is 16 or 17 or 18 or 91 or 92 or >= 160 and <= 165;
    public static uint ModifierBit(uint key) => key switch { 16 or 160 or 161 => 4, 17 or 162 or 163 => 2, 18 or 164 or 165 => 1, 91 or 92 => 8, _ => 0 };
}
/// Transition logic shared by native hooks and tests. Repeats do not trigger
/// more actions, and releasing any required input ends a recording hold.
internal sealed class HotkeyStateMachine
{
    private readonly Dictionary<InputChord, string> bindings;
    private readonly HashSet<uint> pressed = new(), swallowed = new();
    private InputChord? held;
    public string? Recording { get; private set; }
    public bool IsHolding => held.HasValue;
    public bool Enabled { get; set; } = true;
    public event Action<string>? Action;
    public event Action<string, InputChord?>? Recorded;
    public HotkeyStateMachine(SenderSettings settings) { bindings = settings.Bindings().GroupBy(pair => pair.Chord).ToDictionary(group => group.Key, group => group.First().Action); }
    public void BeginRecording(string action) { Recording = action; }
    public void CancelRecording() { if (Recording is { } action) { Recording = null; Recorded?.Invoke(action, null); } }
    public bool Feed(uint key, bool down, uint modifiers)
    {
        if (!down) {
            pressed.Remove(key);
            if (held is { } chord && (key == chord.Key || (modifiers & chord.Modifiers) != chord.Modifiers)) { held = null; Action?.Invoke("voiceRelease"); }
            return swallowed.Remove(key);
        }
        if (!pressed.Add(key)) return swallowed.Contains(key);
        if (Recording is { } recording) {
            if (key == 27) { Recording = null; Recorded?.Invoke(recording, null); swallowed.Add(key); return true; }
            if (InputChord.IsModifier(key)) return false;
            var candidate = new InputChord(modifiers, key);
            if (!candidate.IsValid) return false;
            Recording = null; Recorded?.Invoke(recording, candidate); swallowed.Add(key); return true;
        }
        if (!Enabled || !bindings.TryGetValue(new InputChord(modifiers, key), out var action)) return false;
        if (held is not null && action != "voiceStop") return false;
        if (action == "voiceStop") held = null;
        if (action == "voiceHold") held = new InputChord(modifiers, key);
        Action?.Invoke(action); swallowed.Add(key); return true;
    }
}
