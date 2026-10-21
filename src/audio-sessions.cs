// Read render sessions on every active output device, including inactive sessions.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ListenAudioSessions {
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumEndpoints(IntPtr self, int flow, uint mask, out IntPtr devices);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Count(IntPtr self, out uint count);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Item(IntPtr self, uint index, out IntPtr item);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Activate(IntPtr self, ref Guid iid, uint context, IntPtr parameters, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetEnumerator(IntPtr self, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetProcessId(IntPtr self, out uint pid);
    static T Method<T>(IntPtr obj, int slot) {
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size), typeof(T));
    }
    static void Check(int hr) { Marshal.ThrowExceptionForHR(hr); }
    static void Release(IntPtr ptr) { if (ptr != IntPtr.Zero) Marshal.Release(ptr); }

    public static uint[] Read() {
        var result = new HashSet<uint>();
        object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
        IntPtr unknown = Marshal.GetIUnknownForObject(instance), enumerator = IntPtr.Zero, devices = IntPtr.Zero;
        try {
            Guid iid = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
            Check(Marshal.QueryInterface(unknown, ref iid, out enumerator));
            Check(Method<EnumEndpoints>(enumerator, 3)(enumerator, 0, 1, out devices));
            uint count; Check(Method<Count>(devices, 3)(devices, out count));
            for (uint i = 0; i < count; i++) {
                IntPtr device = IntPtr.Zero, manager = IntPtr.Zero, sessions = IntPtr.Zero;
                try {
                    Check(Method<Item>(devices, 4)(devices, i, out device));
                    Guid managerId = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
                    Check(Method<Activate>(device, 3)(device, ref managerId, 23, IntPtr.Zero, out manager));
                    Check(Method<GetEnumerator>(manager, 5)(manager, out sessions));
                    uint n; Check(Method<Count>(sessions, 3)(sessions, out n));
                    for (uint j = 0; j < n; j++) {
                        IntPtr session = IntPtr.Zero, control = IntPtr.Zero;
                        try {
                            Check(Method<Item>(sessions, 4)(sessions, j, out session));
                            Guid controlId = new Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D");
                            Check(Marshal.QueryInterface(session, ref controlId, out control));
                            uint state; Check(Method<Count>(control, 3)(control, out state));
                            if (state == 2) continue; // Expired; retain both active and inactive sessions.
                            uint pid; Check(Method<GetProcessId>(control, 14)(control, out pid));
                            if (pid != 0) result.Add(pid);
                        } catch (COMException) { /* A session can disappear during enumeration. */ }
                        finally { Release(control); Release(session); }
                    }
                } finally { Release(sessions); Release(manager); Release(device); }
            }
        } finally { Release(devices); Release(enumerator); Release(unknown); Marshal.FinalReleaseComObject(instance); }
        var values = new uint[result.Count]; result.CopyTo(values); return values;
    }
}
