// List every titled top-level window, hidden ones included, with its process id.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class ListenWindowTitles {
    public class Row {
        public uint pid { get; set; }
        public bool visible { get; set; }
        public string cls { get; set; }
        public string title { get; set; }
    }

    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

    public static List<Row> Read() {
        var rows = new List<Row>();
        EnumWindows(delegate(IntPtr h, IntPtr lp) {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            var title = new StringBuilder(512);
            GetWindowText(h, title, title.Capacity);
            if (title.Length == 0) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, cls.Capacity);
            rows.Add(new Row { pid = pid, visible = IsWindowVisible(h), cls = cls.ToString(), title = title.ToString() });
            return true;
        }, IntPtr.Zero);
        return rows;
    }
}
