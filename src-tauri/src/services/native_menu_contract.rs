pub(crate) fn shell_menu_message_requires_forwarding(message: u32) -> bool {
    matches!(message, 0x0117 | 0x002B | 0x002C | 0x0120)
}

#[cfg(test)]
mod tests {
    use super::shell_menu_message_requires_forwarding;

    #[test]
    fn shell_submenu_lifecycle_messages_are_forwarded() {
        for message in [0x0117, 0x002B, 0x002C, 0x0120] {
            assert!(shell_menu_message_requires_forwarding(message));
        }
        assert!(!shell_menu_message_requires_forwarding(0x000F));
    }
}
