using System.Runtime.InteropServices;
namespace CaptureCodexSender.WinUI;
internal sealed class GlobalHotkeyService : IDisposable
{
    private readonly SenderSettings settings;
    private readonly HotkeyStateMachine state;
    private readonly object sync = new();
    private readonly HashSet<uint> modifierKeys = new();
    private Thread? thread;
    private uint threadId, modifiers;
    private volatile bool disposed;
    private bool registered;
    private IntPtr keyboard, mouse;
    private HookProc? keyboardProc, mouseProc;
    public string RegistrationError { get; private set; } = "";
    public event Action<string>? Pressed;
    public event Action<string, InputChord?>? Recorded;
    public GlobalHotkeyService(SenderSettings settings)
    {
        this.settings = settings; state = new HotkeyStateMachine(settings);
        state.Action += action => Pressed?.Invoke(action);
        state.Recorded += (action, chord) => Recorded?.Invoke(action, chord);
    }
    public void BeginRecording(string action) { lock (sync) state.BeginRecording(action); }
    public void CancelRecording() { lock (sync) state.CancelRecording(); }
    public bool Start()
    {
        if (thread is not null) return registered;
        using var ready = new ManualResetEventSlim();
        thread = new Thread(() => Run(ready)) { IsBackground = true, Name = "WindowsSender input hooks" };
        thread.Start(); ready.Wait(); return registered;
    }
    private void Run(ManualResetEventSlim ready)
    {
        threadId = GetCurrentThreadId(); PeekMessage(out _, IntPtr.Zero, 0, 0, 0);
        var ids = new List<int>(); var errors = new List<string>(); var id = 0xC0D1;
        if (settings.Bindings().GroupBy(pair => pair.Chord).Any(group => group.Count() > 1)) errors.Add("热键重复");
        foreach (var (action, chord) in settings.Bindings()) {
            if (!chord.IsValid) { errors.Add(action); id++; continue; }
            if (!chord.IsMouse) {
                if (RegisterHotKey(IntPtr.Zero, id, chord.Modifiers | 0x4000, chord.Key)) ids.Add(id);
                else errors.Add(action);
            }
            id++;
        }
        keyboardProc = KeyboardHook; mouseProc = MouseHook;
        keyboard = SetWindowsHookEx(13, keyboardProc, GetModuleHandle(null), 0);
        mouse = SetWindowsHookEx(14, mouseProc, GetModuleHandle(null), 0);
        if (keyboard == IntPtr.Zero || mouse == IntPtr.Zero) errors.Add("键盘/鼠标监听");
        RegistrationError = string.Join("、", errors); registered = errors.Count == 0; state.Enabled = registered;
        foreach (var key in new uint[] { 160, 161, 162, 163, 164, 165, 91, 92 }) if ((GetAsyncKeyState((int)key) & 0x8000) != 0) modifierKeys.Add(key);
        modifiers = modifierKeys.Aggregate(0u, (bits, key) => bits | InputChord.ModifierBit(key));
        ready.Set();
        while (!disposed && GetMessage(out _, IntPtr.Zero, 0, 0) > 0) { }
        if (keyboard != IntPtr.Zero) UnhookWindowsHookEx(keyboard);
        if (mouse != IntPtr.Zero) UnhookWindowsHookEx(mouse);
        foreach (var reserved in ids) UnregisterHotKey(IntPtr.Zero, reserved);
    }
    private IntPtr KeyboardHook(int code, UIntPtr message, IntPtr data)
    {
        if (code >= 0) {
            var value = Marshal.PtrToStructure<KeyboardData>(data);
            var kind = message.ToUInt64(); var down = kind is 0x100 or 0x104;
            if (down || kind is 0x101 or 0x105) { lock (sync) {
                if (InputChord.IsModifier(value.Key)) {
                    if (down) modifierKeys.Add(value.Key); else modifierKeys.Remove(value.Key);
                    modifiers = modifierKeys.Aggregate(0u, (bits, key) => bits | InputChord.ModifierBit(key));
                }
                var consumed = state.Feed(value.Key, down, modifiers);
                if (consumed) return new IntPtr(1);
            } }
        }
        return CallNextHookEx(keyboard, code, message, data);
    }
    private IntPtr MouseHook(int code, UIntPtr message, IntPtr data)
    {
        if (code >= 0) {
            var kind = message.ToUInt64(); var value = Marshal.PtrToStructure<MouseData>(data);
            uint key = kind switch { 0x201 or 0x202 => 1, 0x204 or 0x205 => 2, 0x207 or 0x208 => 4, 0x20B or 0x20C => (value.ButtonData >> 16) == 1 ? 5u : 6u, _ => 0 };
            if (key != 0) { lock (sync) {
                var down = kind is 0x201 or 0x204 or 0x207 or 0x20B;
                var consumed = state.Feed(key, down, modifiers);
                if (consumed) return new IntPtr(1);
            } }
        }
        return CallNextHookEx(mouse, code, message, data);
    }
    public void Dispose() { disposed = true; if (threadId != 0) PostThreadMessage(threadId, 0x12, UIntPtr.Zero, IntPtr.Zero); if (thread != Thread.CurrentThread) thread?.Join(2000); thread = null; }
    private delegate IntPtr HookProc(int code, UIntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardData { public uint Key, ScanCode, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseData { public int X, Y; public uint ButtonData, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr Window; public uint Kind; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X, Y; public uint Private; }
    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
    [DllImport("user32.dll")] private static extern IntPtr SetWindowsHookEx(int kind, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, UIntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? name);
}
