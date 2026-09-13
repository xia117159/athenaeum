use std::{io::Read, process::{Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, mpsc}, thread, time::{Duration, Instant}};
use super::TransportError;

#[derive(Clone, Copy)]
pub(super) struct OutputLimits { pub bytes: usize, pub line_bytes: usize, pub timeout: Duration }
impl Default for OutputLimits {
    fn default() -> Self { Self { bytes: 8 * 1024 * 1024, line_bytes: 16 * 1024, timeout: Duration::from_secs(20) } }
}
pub(super) struct ProcessExit { pub code: Option<i32>, pub bytes: usize }

pub(super) fn stream_process(mut command: Command, cancelled: &AtomicBool, limits: OutputLimits,
    visit: &mut dyn FnMut(&[u8]) -> bool) -> Result<ProcessExit, TransportError> {
    if cancelled.load(Ordering::Relaxed) { return Err(TransportError::Cancelled); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    let mut child = command.spawn().map_err(|_| TransportError::Failed("无法启动 FTP 元数据读取进程".into()))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    // A bounded pipe pump: one 4 KiB read buffer plus at most two queued chunks.
    // It never accumulates a whole server directory or unbounded stderr.
    let (sender, receiver) = mpsc::sync_channel(2);
    let reader = thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => if sender.send(Ok(buffer[..count].to_vec())).is_err() { break; },
                Err(_) => { let _ = sender.send(Err(())); break; }
            }
        }
    });
    let started = Instant::now();
    let result = (|| {
        let mut bytes = 0_usize;
        let mut line = Vec::with_capacity(limits.line_bytes.min(4096));
        let mut eof = false;
        loop {
            if cancelled.load(Ordering::Relaxed) { return Err(TransportError::Cancelled); }
            if started.elapsed() >= limits.timeout { return Err(TransportError::Failed("FTP 目录元数据读取超时".into())); }
            if eof {
                if let Some(status) = child.try_wait().map_err(|_| TransportError::Failed("FTP 进程状态不可用".into()))? {
                    return Ok(ProcessExit { code: status.code(), bytes });
                }
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(Ok(chunk)) => {
                    if chunk.len() > limits.bytes.saturating_sub(bytes) { return Err(TransportError::OutputLimit(format!("FTP 元数据输出超过 {} 字节上限", limits.bytes))); }
                    bytes += chunk.len();
                    for byte in chunk {
                        if byte == b'\n' {
                            if !visit(&line) {
                                return if cancelled.load(Ordering::Relaxed) { Err(TransportError::Cancelled) }
                                    else { Ok(ProcessExit { code: Some(0), bytes }) };
                            }
                            line.clear();
                        } else {
                            if line.len() >= limits.line_bytes { return Err(TransportError::OutputLimit(format!("FTP 单行元数据超过 {} 字节上限", limits.line_bytes))); }
                            line.push(byte);
                        }
                    }
                }
                Ok(Err(())) => return Err(TransportError::Failed("FTP 元数据输出读取失败".into())),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    eof = true;
                    if !line.is_empty() && !visit(&line) {
                        return if cancelled.load(Ordering::Relaxed) { Err(TransportError::Cancelled) }
                            else { Ok(ProcessExit { code: Some(0), bytes }) };
                    }
                }
            }
        }
    })();
    // Also covers cancellation, visitor budgets and malformed/oversized output.
    // Drop the receiver before joining so a full producer queue cannot deadlock.
    let _ = child.kill();
    let _ = child.wait();
    drop(receiver);
    let _ = reader.join();
    result
}
