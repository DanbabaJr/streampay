use std::{cell::RefCell, string::String};

std::thread_local! {
    static OPERATIONS: RefCell<String> = const { RefCell::new(String::new()) };
}

pub(crate) fn begin() {
    OPERATIONS.with(|operations| operations.borrow_mut().clear());
}

pub(crate) fn record(operation: &str) {
    OPERATIONS.with(|operations| {
        let mut operations = operations.borrow_mut();
        if !operations.is_empty() {
            operations.push('\n');
        }
        operations.push_str(operation);
    });
}

pub(crate) fn finish() -> String {
    OPERATIONS.with(|operations| operations.borrow().clone())
}
