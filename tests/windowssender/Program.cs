using CaptureCodexSender.WinUI;
using System.Text.Json;
// Synthetic audio/images only. Commands exercise the real .NET sender client.
var settings = new SenderSettings { Host = "127.0.0.1", Port = int.Parse(args[0]), PairingToken = args[1], CertificateSha256 = args[2] };
var queue = args[3]; Directory.CreateDirectory(queue);
var client = new CaptureService(settings, queue);
await using var lifetime = client;
while (await Console.In.ReadLineAsync() is { } line)
{
    try
    {
        using var document = JsonDocument.Parse(line);
        var command = document.RootElement.GetProperty("command").GetString();
        object? result = null;
        switch (command)
        {
            case "seed":
                var ids = new List<string>();
                for (var i = 0; i < 2; i++)
                {
                    var id = Guid.NewGuid().ToString("N"); ids.Add(id);
                    var image = Path.Combine(queue, id + ".png");
                    await File.WriteAllBytesAsync(image, Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4cAAAAASUVORK5CYII="));
                    await File.WriteAllTextAsync(Path.Combine(queue, id + ".json"), JsonSerializer.Serialize(new CaptureService.QueuedCapture(id, $"test-display-{i}", image, Guid.NewGuid().ToString("N"), i + 1)));
                }
                result = ids; break;
            case "stage": await client.StagePendingAsync(); result = client.PendingCount; break;
            case "send": result = await client.SendPendingAsync(); break;
            case "duplicate-send": result = await Task.WhenAll(client.SendPendingAsync(), client.SendPendingAsync()); break;
            case "start": await client.StartVoiceAsync(); result = client.VoiceActive; break;
            case "stop": result = await client.StopVoiceAsync(); break;
            case "cancel": await client.CancelVoiceAsync(); result = client.VoiceActive; break;
            case "status": result = await client.GetStatusAsync(); break;
            case "remove-last": result = await client.RemoveCapturesAsync(); break;
            case "remove-all": result = await client.RemoveCapturesAsync(all: true); break;
            case "input-tests":
                var inputSettings = new SenderSettings { VoiceHoldToTalk = true, VoiceHoldHotkeyModifiers = 2, VoiceHoldHotkeyVirtualKey = 5 };
                inputSettings.Validate(false);
                var state = new HotkeyStateMachine(inputSettings); var actions = new List<string>();
                state.Action += actions.Add;
                if (!state.Feed(5, true, 2)) throw new Exception("Mouse chord not matched");
                state.Feed(5, true, 2); state.Feed(5, false, 2);
                if (!actions.SequenceEqual(new[] { "voiceHold", "voiceRelease" })) throw new Exception("Hold repeat/release incorrect");
                actions.Clear(); state.Feed(5, true, 2); state.Feed(162, false, 0); state.Feed(5, false, 0);
                if (!actions.SequenceEqual(new[] { "voiceHold", "voiceRelease" })) throw new Exception("Modifier release did not stop hold once");
                InputChord? recorded = null; state.Recorded += (_, chord) => recorded = chord;
                state.BeginRecording("remove"); state.Feed(6, true, 0); state.Feed(6, false, 0);
                if (recorded != new InputChord(0, 6)) throw new Exception("Mouse recording incorrect");
                state.BeginRecording("capture"); state.Feed(17, true, 2); state.Feed(112, true, 2); state.Feed(112, false, 2); state.Feed(17, false, 0);
                if (recorded != new InputChord(2, 112)) throw new Exception("Keyboard recording incorrect");
                state.BeginRecording("capture"); state.Feed(27, true, 0); state.Feed(27, false, 0);
                if (recorded is not null || state.Recording is not null) throw new Exception("Escape cancellation incorrect");
                var separate = new HotkeyStateMachine(new SenderSettings()); var separateActions = new List<string>(); separate.Action += separateActions.Add;
                separate.Feed(86, true, 3); separate.Feed(86, true, 3); separate.Feed(86, false, 3); separate.Feed(66, true, 3); separate.Feed(66, false, 3);
                if (!separateActions.SequenceEqual(new[] { "voice", "voiceStop" })) throw new Exception("Separate voice keys regressed");
                actions.Clear();
                state.Feed(86, true, 3); state.Feed(86, false, 3); state.Feed(66, true, 3); state.Feed(66, false, 3);
                if (actions.Count != 0) throw new Exception("Hidden separate voice keys are still active in hold mode");
                var separateWithHold = new HotkeyStateMachine(new SenderSettings { VoiceHoldHotkeyModifiers = 2, VoiceHoldHotkeyVirtualKey = 5 });
                var inactiveActions = new List<string>(); separateWithHold.Action += inactiveActions.Add;
                separateWithHold.Feed(5, true, 2); separateWithHold.Feed(5, false, 2);
                if (inactiveActions.Count != 0) throw new Exception("Hidden hold key is still active in separate mode");
                var overlappingModes = new SenderSettings { VoiceHoldToTalk = true, VoiceHoldHotkeyModifiers = 3, VoiceHoldHotkeyVirtualKey = 66 };
                overlappingModes.Validate(false);
                if (overlappingModes.Bindings().Count() != 4) throw new Exception("Hold mode should register one recording chord");
                if (overlappingModes.AllBindings().Single(p => p.Action == "voiceStop").Chord != new InputChord(3, 66)) throw new Exception("Separate voice key lost");
                var legacy = JsonSerializer.Deserialize<SenderSettings>("{\"VoiceHoldToTalk\":true,\"VoiceHotkeyModifiers\":0,\"VoiceHotkeyVirtualKey\":5}")!;
                if (legacy.Bindings().Single(p => p.Action == "voiceHold").Chord != new InputChord(0, 5)) throw new Exception("Legacy hold binding not preserved");
                foreach (var sideKey in new uint[] { 5, 6 }) {
                    var heldMouse = new HotkeyStateMachine(new SenderSettings { VoiceHoldToTalk = true, VoiceHoldHotkeyModifiers = 0, VoiceHoldHotkeyVirtualKey = sideKey });
                    var heldActions = new List<string>(); heldMouse.Action += heldActions.Add;
                    heldMouse.Feed(sideKey, true, 0);
                    for (var repeat = 0; repeat < 50; repeat++) {
                        heldMouse.Feed(sideKey, true, 0);
                        heldMouse.Feed(65, true, 0); heldMouse.Feed(65, false, 0);
                    }
                    if (!heldMouse.IsHolding || !heldActions.SequenceEqual(new[] { "voiceHold" })) throw new Exception("Mouse hold ended without release");
                    heldMouse.Feed(sideKey, false, 0); heldMouse.Feed(sideKey, false, 0);
                    if (heldMouse.IsHolding || !heldActions.SequenceEqual(new[] { "voiceHold", "voiceRelease" })) throw new Exception("Side button release must stop once");
                }
                result = new { passed = 12 }; break;
            case "bad-pin": settings.CertificateSha256 = new string('0', 64); await using (var changed = new CaptureService(settings, queue)) { await changed.GetStatusAsync(); } break;
            case "restore-pin": settings.CertificateSha256 = args[2]; break;
            case "bad-token": settings.PairingToken = "wrong-token"; await client.GetStatusAsync(); break;
            case "restore-token": settings.PairingToken = args[1]; break;
            case "validate-hotkeys": settings.SendHotkeyVirtualKey = settings.HotkeyVirtualKey; settings.Validate(); break;
            default: throw new InvalidOperationException("Unknown test command");
        }
        Console.WriteLine(JsonSerializer.Serialize(new { ok = true, result }));
    }
    catch (Exception error) { Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = error.Message })); }
}
