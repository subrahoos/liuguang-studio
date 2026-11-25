export const windowsPickerDpiSource = `
using System;
using System.Runtime.InteropServices;

public static class LumaWindowsPickerDpi
{
    private static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int awareness);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDPIAware();

    public static void Enable()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(PerMonitorAwareV2)) return;
        }
        catch (EntryPointNotFoundException) { }
        catch (DllNotFoundException) { }

        try
        {
            const int ProcessPerMonitorDpiAware = 2;
            if (SetProcessDpiAwareness(ProcessPerMonitorDpiAware) == 0) return;
        }
        catch (EntryPointNotFoundException) { }
        catch (DllNotFoundException) { }

        try
        {
            SetProcessDPIAware();
        }
        catch (EntryPointNotFoundException) { }
        catch (DllNotFoundException) { }
    }
}
`;
