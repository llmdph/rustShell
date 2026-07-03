#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use rustshell::native_slint::{view_models as native_vm, NativeRuntime, RuntimeSnapshot};
use slint::{ComponentHandle, ModelRc, SharedString, Timer, TimerMode, VecModel};
use std::{cell::RefCell, rc::Rc, time::Duration};

slint::include_modules!();

fn main() -> Result<(), slint::PlatformError> {
    let app = AppWindow::new()?;
    let file_window = FileManagerWindow::new()?;
    let runtime = Rc::new(RefCell::new(NativeRuntime::new()));

    runtime.borrow_mut().start_default_terminal();
    apply_snapshot(&app, &file_window, runtime.borrow().snapshot());

    bind_app_callbacks(&app, &file_window, runtime.clone());
    bind_file_callbacks(&app, &file_window, runtime.clone());

    let poll_timer = Timer::default();
    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_timer = runtime.clone();
    poll_timer.start(TimerMode::Repeated, Duration::from_millis(33), move || {
        let Some(app) = app_weak.upgrade() else {
            return;
        };
        let Some(file_window) = file_weak.upgrade() else {
            return;
        };
        let snapshot = runtime_for_timer.borrow_mut().poll();
        apply_snapshot(&app, &file_window, snapshot);
    });

    app.run()
}

fn bind_app_callbacks(
    app: &AppWindow,
    file_window: &FileManagerWindow,
    runtime: Rc<RefCell<NativeRuntime>>,
) {
    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_refresh = runtime.clone();
    app.on_refresh_sessions(move || {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_refresh.borrow_mut().reload_sessions();
            apply_snapshot(app, file_window, runtime_for_refresh.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_select = runtime.clone();
    app.on_select_session(move |id| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_select.borrow_mut().select_session(&id);
            apply_snapshot(app, file_window, runtime_for_select.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_connect = runtime.clone();
    app.on_connect_session(move |id| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_connect.borrow_mut().connect_session(&id);
            apply_snapshot(app, file_window, runtime_for_connect.borrow_mut().poll());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_quick = runtime.clone();
    app.on_connect_quick(move |selector| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_quick.borrow_mut().connect_quick(&selector);
            apply_snapshot(app, file_window, runtime_for_quick.borrow_mut().poll());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_local = runtime.clone();
    app.on_open_local_terminal(move || {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_local.borrow_mut().open_local_terminal();
            apply_snapshot(app, file_window, runtime_for_local.borrow_mut().poll());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_files = runtime.clone();
    app.on_open_file_manager(move || {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_files.borrow_mut().open_file_manager();
            apply_snapshot(app, file_window, runtime_for_files.borrow().snapshot());
            file_window.show().ok();
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_settings = runtime.clone();
    app.on_open_settings(move || {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_settings.borrow_mut().open_settings();
            apply_snapshot(app, file_window, runtime_for_settings.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_terminal = runtime.clone();
    app.on_terminal_control(move |action| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            let _ = runtime_for_terminal.borrow_mut().terminal_control(&action);
            apply_snapshot(app, file_window, runtime_for_terminal.borrow_mut().poll());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_send = runtime.clone();
    app.on_send_terminal_command(move |command| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_send
                .borrow_mut()
                .send_terminal_command(&command);
            apply_snapshot(app, file_window, runtime_for_send.borrow_mut().poll());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_modal = runtime.clone();
    app.on_close_modal(move || {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_modal.borrow_mut().clear_modal();
            apply_snapshot(app, file_window, runtime_for_modal.borrow().snapshot());
        });
    });

    app.on_window_action(move |action| {
        if action.as_str() == "close" {
            slint::quit_event_loop().ok();
        }
    });
}

fn bind_file_callbacks(
    app: &AppWindow,
    file_window: &FileManagerWindow,
    runtime: Rc<RefCell<NativeRuntime>>,
) {
    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_local = runtime.clone();
    file_window.on_refresh_local(move |path| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_local.borrow_mut().refresh_local(&path);
            apply_snapshot(app, file_window, runtime_for_local.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_remote = runtime.clone();
    file_window.on_refresh_remote(move |selector, path| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_remote
                .borrow_mut()
                .refresh_remote(&selector, &path);
            apply_snapshot(app, file_window, runtime_for_remote.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_home = runtime.clone();
    file_window.on_local_home(move || {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_home.borrow_mut().local_home();
            apply_snapshot(app, file_window, runtime_for_home.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_home = runtime.clone();
    file_window.on_remote_home(move || {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            let selector = file_window.get_remote_selector().to_string();
            runtime_for_home.borrow_mut().remote_home(&selector);
            apply_snapshot(app, file_window, runtime_for_home.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_parent = runtime.clone();
    file_window.on_local_parent(move |path| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_parent.borrow_mut().local_parent(&path);
            apply_snapshot(app, file_window, runtime_for_parent.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_parent = runtime.clone();
    file_window.on_remote_parent(move |path| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            let selector = file_window.get_remote_selector().to_string();
            runtime_for_parent
                .borrow_mut()
                .remote_parent(&selector, &path);
            apply_snapshot(app, file_window, runtime_for_parent.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_select = runtime.clone();
    file_window.on_select_local(move |path| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_select.borrow_mut().select_local(&path);
            apply_snapshot(app, file_window, runtime_for_select.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_select = runtime.clone();
    file_window.on_select_remote(move |path| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_select.borrow_mut().select_remote(&path);
            apply_snapshot(app, file_window, runtime_for_select.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_transfer = runtime.clone();
    file_window.on_transfer(move |action| {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_transfer.borrow_mut().transfer(&action);
            apply_snapshot(app, file_window, runtime_for_transfer.borrow().snapshot());
        });
    });

    let app_weak = app.as_weak();
    let file_weak = file_window.as_weak();
    let runtime_for_modal = runtime.clone();
    file_window.on_close_modal(move || {
        with_windows(&app_weak, &file_weak, |app, file_window| {
            runtime_for_modal.borrow_mut().clear_file_modal();
            apply_snapshot(app, file_window, runtime_for_modal.borrow().snapshot());
        });
    });

    let file_weak = file_window.as_weak();
    file_window.on_window_action(move |action| {
        if let Some(file_window) = file_weak.upgrade() {
            if matches!(action.as_str(), "hide" | "close") {
                file_window.hide().ok();
            }
        }
    });
}

fn with_windows(
    app_weak: &slint::Weak<AppWindow>,
    file_weak: &slint::Weak<FileManagerWindow>,
    f: impl FnOnce(&AppWindow, &FileManagerWindow),
) {
    let Some(app) = app_weak.upgrade() else {
        return;
    };
    let Some(file_window) = file_weak.upgrade() else {
        return;
    };
    f(&app, &file_window);
}

fn apply_snapshot(app: &AppWindow, file_window: &FileManagerWindow, snapshot: RuntimeSnapshot) {
    app.set_theme_mode(snapshot.theme_mode);
    app.set_session_rows(model(
        snapshot.session_rows.into_iter().map(session_vm).collect(),
    ));
    app.set_terminal_tabs(model(
        snapshot
            .terminal
            .tabs
            .into_iter()
            .map(terminal_tab_vm)
            .collect(),
    ));
    app.set_terminal_lines(model(
        snapshot
            .terminal
            .lines
            .into_iter()
            .map(terminal_line_vm)
            .collect(),
    ));
    app.set_preview_name(snapshot.session_preview.name.into());
    app.set_preview_host(snapshot.session_preview.host.into());
    app.set_preview_user(snapshot.session_preview.user.into());
    app.set_preview_protocol(snapshot.session_preview.protocol.into());
    app.set_preview_port(snapshot.session_preview.port.into());
    set_app_modal(app, snapshot.modal);

    let files = snapshot.files;
    file_window.set_theme_mode(snapshot.theme_mode);
    file_window.set_local_path(files.local_path.into());
    file_window.set_remote_path(files.remote_path.into());
    file_window.set_remote_selector(files.remote_selector.into());
    file_window.set_local_entries(model(
        files.local_entries.into_iter().map(file_entry_vm).collect(),
    ));
    file_window.set_remote_entries(model(
        files
            .remote_entries
            .into_iter()
            .map(file_entry_vm)
            .collect(),
    ));
    set_file_modal(file_window, files.modal);
}

fn set_app_modal(app: &AppWindow, modal: Option<native_vm::DialogVm>) {
    if let Some(modal) = modal {
        app.set_modal_title(modal.title.into());
        app.set_modal_body(modal.body.into());
    } else {
        app.set_modal_title(SharedString::default());
        app.set_modal_body(SharedString::default());
    }
}

fn set_file_modal(file_window: &FileManagerWindow, modal: Option<native_vm::DialogVm>) {
    if let Some(modal) = modal {
        file_window.set_modal_title(modal.title.into());
        file_window.set_modal_body(modal.body.into());
    } else {
        file_window.set_modal_title(SharedString::default());
        file_window.set_modal_body(SharedString::default());
    }
}

fn model<T: Clone + 'static>(items: Vec<T>) -> ModelRc<T> {
    ModelRc::new(VecModel::from(items))
}

fn session_vm(row: native_vm::SessionNodeVm) -> SessionNodeVm {
    SessionNodeVm {
        id: row.id.into(),
        name: row.name.into(),
        protocol: row.protocol.into(),
        status: row.status.into(),
        depth: row.depth,
        is_folder: row.is_folder,
        selected: row.selected,
    }
}

fn terminal_tab_vm(tab: native_vm::TerminalTabVm) -> TerminalTabVm {
    TerminalTabVm {
        id: tab.id.into(),
        title: tab.title.into(),
        status: tab.status.into(),
        active: tab.active,
    }
}

fn terminal_line_vm(line: native_vm::TerminalLineVm) -> TerminalLineVm {
    TerminalLineVm {
        text: line.text.into(),
    }
}

fn file_entry_vm(entry: native_vm::FileEntryVm) -> FileEntryVm {
    FileEntryVm {
        name: entry.name.into(),
        path: entry.path.into(),
        kind: entry.kind.into(),
        permissions: entry.permissions.into(),
        owner: entry.owner.into(),
        size: entry.size.into(),
        modified: entry.modified.into(),
        is_dir: entry.is_dir,
        selected: entry.selected,
    }
}
