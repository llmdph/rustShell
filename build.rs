fn main() {
    #[cfg(feature = "slint-ui")]
    slint_build::compile("slint-native-ui/main.slint").expect("failed to compile Slint UI");

    tauri_build::build();
}
