using System.Runtime.InteropServices;
namespace CaptureCodexSender.WinUI;

/// A native hidden message window owns tray commands and single-instance IPC.
/// Headless mode creates this window without an icon or any visible settings UI.
internal sealed class TrayHost : IDisposable
{
    private const string ClassName = "CaptureCodex.WindowsSender.BackgroundHost.v3";
    private const uint ShowCommand = 0x8001, ExitCommand = 0x8002, TrayCallback = 0x8003;
    private readonly Action show, exit;
    private readonly bool iconVisible;
    private readonly Thread thread;
    private readonly WndProc proc;
    private IntPtr window;
    private uint taskbarCreated;
    private NotifyIconData icon;
    public TrayHost(bool iconVisible, Action show, Action exit)
    {
        this.iconVisible = iconVisible; this.show = show; this.exit = exit; proc = WindowProc;
        using var ready = new ManualResetEventSlim();
        thread = new Thread(() => Run(ready)) { IsBackground = true, Name = "WindowsSender tray" };
        thread.Start(); ready.Wait();
        if (window == IntPtr.Zero) throw new InvalidOperationException("无法创建后台入口。");
    }
    public static void NotifyExisting(bool exit)
    {
        for (var attempt = 0; attempt < 20; attempt++) {
            var handle = FindWindow(ClassName, null);
            if (handle != IntPtr.Zero) { PostMessage(handle, exit ? ExitCommand : ShowCommand, UIntPtr.Zero, IntPtr.Zero); return; }
            Thread.Sleep(50);
        }
    }
    private void Run(ManualResetEventSlim ready)
    {
        var cls = new WindowClass { Size = (uint)Marshal.SizeOf<WindowClass>(), Instance = GetModuleHandle(null), Proc = Marshal.GetFunctionPointerForDelegate(proc), ClassName = ClassName };
        RegisterClassEx(ref cls);
        window = CreateWindowEx(0, ClassName, "WindowsSender background host", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, cls.Instance, IntPtr.Zero);
        taskbarCreated = RegisterWindowMessage("TaskbarCreated");
        icon = new NotifyIconData { Size = (uint)Marshal.SizeOf<NotifyIconData>(), Window = window, Id = 1, Flags = 1 | 2 | 4,
            CallbackMessage = TrayCallback, Icon = LoadIcon(IntPtr.Zero, new IntPtr(32512)), Tip = "WindowsSender · 双击打开设置，右键退出", Info = "", InfoTitle = "" };
        if (iconVisible && window != IntPtr.Zero) ShellNotifyIcon(0, ref icon);
        ready.Set();
        while (GetMessage(out var message, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessage(ref message); }
    }
    private IntPtr WindowProc(IntPtr handle, uint message, UIntPtr wParam, IntPtr lParam)
    {
        if (message == ShowCommand) { show(); return IntPtr.Zero; }
        if (message == ExitCommand) { exit(); return IntPtr.Zero; }
        if (message == taskbarCreated && iconVisible) { ShellNotifyIcon(0, ref icon); return IntPtr.Zero; }
        if (message == TrayCallback) {
            var action = lParam.ToInt64();
            if (action == 0x203) show();
            if (action == 0x205 || action == 0x7B) {
                var menu = CreatePopupMenu(); AppendMenu(menu, 0, new UIntPtr(1), "打开 WindowsSender 设置"); AppendMenu(menu, 0, new UIntPtr(2), "退出 WindowsSender");
                GetCursorPos(out var point); SetForegroundWindow(handle);
                var selected = TrackPopupMenu(menu, 0x100 | 0x2, point.X, point.Y, 0, handle, IntPtr.Zero);
                DestroyMenu(menu); if (selected == 1) show(); else if (selected == 2) exit();
                PostMessage(handle, 0, UIntPtr.Zero, IntPtr.Zero);
            }
            return IntPtr.Zero;
        }
        if (message == 0x10) { if (iconVisible) ShellNotifyIcon(2, ref icon); DestroyWindow(handle); return IntPtr.Zero; }
        if (message == 2) { PostQuitMessage(0); return IntPtr.Zero; }
        return DefWindowProc(handle, message, wParam, lParam);
    }
    public void Dispose() { if (window != IntPtr.Zero) PostMessage(window, 0x10, UIntPtr.Zero, IntPtr.Zero); thread.Join(2000); }
    private delegate IntPtr WndProc(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WindowClass { public uint Size, Style; public IntPtr Proc; public int ClassExtra, WindowExtra; public IntPtr Instance, Icon, Cursor, Background; public string? MenuName, ClassName; public IntPtr SmallIcon; }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr Window; public uint Kind; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Point; public uint Private; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct NotifyIconData { public uint Size; public IntPtr Window; public uint Id, Flags, CallbackMessage; public IntPtr Icon; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip; public uint State, StateMask; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info; public uint Timeout; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string InfoTitle; public uint InfoFlags; public Guid Guid; public IntPtr BalloonIcon; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassEx(ref WindowClass value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowEx(uint extended, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string cls, string? title);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProc(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessage(string message);
    [DllImport("user32.dll")] private static extern IntPtr LoadIcon(IntPtr instance, IntPtr id);
    [DllImport("shell32.dll", EntryPoint = "Shell_NotifyIconW", CharSet = CharSet.Unicode)] private static extern bool ShellNotifyIcon(uint command, ref NotifyIconData data);
    [DllImport("user32.dll")] private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool AppendMenu(IntPtr menu, uint flags, UIntPtr id, string text);
    [DllImport("user32.dll")] private static extern uint TrackPopupMenu(IntPtr menu, uint flags, int x, int y, int reserved, IntPtr window, IntPtr rect);
    [DllImport("user32.dll")] private static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
}
