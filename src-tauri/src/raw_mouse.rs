#[cfg(target_os = "windows")]
mod platform {
    use serde::Serialize;
    use std::{
        ffi::c_void,
        mem::{size_of, transmute},
        sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, Ordering},
        thread,
        time::Duration,
    };
    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Input::{
                GetRawInputData, RegisterRawInputDevices, HRAWINPUT, MOUSE_MOVE_ABSOLUTE,
                RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEMOUSE,
            },
            WindowsAndMessaging::{
                CallWindowProcW, SetWindowLongPtrW, WNDPROC, GWLP_WNDPROC, WM_INPUT,
            },
        },
    };

    static LOCKED: AtomicBool = AtomicBool::new(false);
    static DELTA_X: AtomicI32 = AtomicI32::new(0);
    static DELTA_Y: AtomicI32 = AtomicI32::new(0);
    static ORIGINAL_WNDPROC: AtomicIsize = AtomicIsize::new(0);

    #[derive(Clone, Serialize)]
    struct MouseDelta {
        x: i32,
        y: i32,
    }

    unsafe extern "system" fn raw_input_wnd_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_INPUT && LOCKED.load(Ordering::Relaxed) {
            let mut input = RAWINPUT::default();
            let mut bytes = size_of::<RAWINPUT>() as u32;
            let read = unsafe {
                GetRawInputData(
                    HRAWINPUT(lparam.0 as *mut c_void),
                    RID_INPUT,
                    Some((&mut input as *mut RAWINPUT).cast()),
                    &mut bytes,
                    size_of::<RAWINPUTHEADER>() as u32,
                )
            };
            if read != u32::MAX && input.header.dwType == RIM_TYPEMOUSE.0 {
                let mouse = unsafe { input.data.mouse };
                // Absolute pointing devices are not suitable for FPS camera deltas.
                if mouse.usFlags.0 & MOUSE_MOVE_ABSOLUTE.0 == 0 {
                    DELTA_X.fetch_add(mouse.lLastX.clamp(-2048, 2048), Ordering::Relaxed);
                    DELTA_Y.fetch_add(mouse.lLastY.clamp(-2048, 2048), Ordering::Relaxed);
                }
            }
        }

        let original = ORIGINAL_WNDPROC.load(Ordering::Acquire);
        if original == 0 {
            return LRESULT(0);
        }
        let original_proc: WNDPROC = unsafe { transmute(original) };
        unsafe { CallWindowProcW(original_proc, hwnd, message, wparam, lparam) }
    }

    pub fn install(app: &AppHandle) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let device = RAWINPUTDEVICE {
            usUsagePage: 0x01,
            usUsage: 0x02,
            // The focused WebView2 renderer is a child HWND, so explicitly route
            // raw mouse packets to the Tauri top-level window.
            dwFlags: RIDEV_INPUTSINK,
            hwndTarget: hwnd,
        };

        unsafe {
            RegisterRawInputDevices(&[device], size_of::<RAWINPUTDEVICE>() as u32)
                .map_err(|error| error.to_string())?;
            let original = SetWindowLongPtrW(
                hwnd,
                GWLP_WNDPROC,
                raw_input_wnd_proc as *const () as usize as isize,
            );
            if original == 0 {
                return Err(windows::core::Error::from_win32().to_string());
            }
            ORIGINAL_WNDPROC.store(original, Ordering::Release);
        }

        let app = app.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(8));
            if !LOCKED.load(Ordering::Relaxed) {
                continue;
            }
            let x = DELTA_X.swap(0, Ordering::Relaxed);
            let y = DELTA_Y.swap(0, Ordering::Relaxed);
            if x != 0 || y != 0 {
                let _ = app.emit_to("main", "game-mouse-delta", MouseDelta { x, y });
            }
        });
        Ok(())
    }

    pub fn set_locked(locked: bool) {
        DELTA_X.store(0, Ordering::Relaxed);
        DELTA_Y.store(0, Ordering::Relaxed);
        LOCKED.store(locked, Ordering::Release);
    }
}

#[cfg(target_os = "windows")]
pub use platform::{install, set_locked};

#[cfg(not(target_os = "windows"))]
pub fn install(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_locked(_locked: bool) {}
