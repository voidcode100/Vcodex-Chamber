using Microsoft.UI.Xaml;
using Microsoft.UI.Dispatching;
namespace CaptureCodexSender.WinUI;
public partial class App : Application
{
    private MainWindow? window;
    private SenderController? controller;
    private TrayHost? tray;
    private Mutex? mutex;
    private bool exiting;
    private DispatcherQueue dispatcher = null!;
    public App() => InitializeComponent();
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        var options = Environment.GetCommandLineArgs().Skip(1).ToHashSet(StringComparer.OrdinalIgnoreCase);
        mutex = new Mutex(true, "Local\\CaptureCodex.WindowsSender.v3", out var first);
        if (!first) { if (options.Contains("--exit") || (!options.Contains("--background") && !options.Contains("--headless"))) TrayHost.NotifyExisting(options.Contains("--exit")); mutex.Dispose(); Exit(); return; }
        if (options.Contains("--exit")) { mutex.ReleaseMutex(); mutex.Dispose(); Exit(); return; }
        dispatcher = DispatcherQueue.GetForCurrentThread(); controller = new SenderController(dispatcher);
        tray = new TrayHost(!options.Contains("--headless"), () => dispatcher.TryEnqueue(ShowSettings), () => dispatcher.TryEnqueue(RequestExit));
        if (options.Contains("--show") || (!options.Contains("--background") && !options.Contains("--headless") && !controller.Settings.StartInBackground)) ShowSettings();
    }
    private void ShowSettings()
    {
        if (exiting || controller is null) return;
        window ??= new MainWindow(controller, RequestExit);
        window.AppWindow.Show(); window.Activate();
    }
    private async void RequestExit()
    {
        if (exiting) return; exiting = true;
        tray?.Dispose();
        if (controller is not null) await controller.DisposeAsync();
        window?.CloseForExit(); mutex?.ReleaseMutex(); mutex?.Dispose(); Exit();
    }
}
