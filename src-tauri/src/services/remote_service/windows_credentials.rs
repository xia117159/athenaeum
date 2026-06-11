use anyhow::Result;

#[cfg(target_os = "windows")]
use std::iter;

#[cfg(target_os = "windows")]
use windows::{
  core::{PCWSTR, PWSTR},
  Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC
  }
};

pub fn read_secret(target: &str) -> Option<String> {
  #[cfg(target_os = "windows")]
  unsafe {
    let target_wide = wide_null(target);
    let mut credential_ptr = std::ptr::null_mut();
    if CredReadW(PCWSTR(target_wide.as_ptr()), CRED_TYPE_GENERIC, Some(0), &mut credential_ptr).is_err() {
      return None;
    }

    let credential = &*credential_ptr;
    let secret_len = credential.CredentialBlobSize as usize;
    let secret = if credential.CredentialBlob.is_null() || secret_len == 0 {
      None
    } else {
      let bytes = std::slice::from_raw_parts(credential.CredentialBlob, secret_len);
      String::from_utf8(bytes.to_vec()).ok()
    };
    CredFree(credential_ptr.cast());
    secret
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = target;
    None
  }
}

pub fn write_secret(target: &str, secret: &str) -> Result<()> {
  #[cfg(target_os = "windows")]
  unsafe {
    let mut target_wide = wide_null(target);
    let secret_bytes = secret.as_bytes().to_vec();
    let mut user_wide = wide_null("SimpleFileManager");

    let credential = CREDENTIALW {
      Flags: CRED_FLAGS(0),
      Type: CRED_TYPE_GENERIC,
      TargetName: PWSTR(target_wide.as_mut_ptr()),
      Comment: PWSTR::null(),
      LastWritten: Default::default(),
      CredentialBlobSize: secret_bytes.len() as u32,
      CredentialBlob: secret_bytes.as_ptr() as *mut u8,
      Persist: CRED_PERSIST_LOCAL_MACHINE,
      AttributeCount: 0,
      Attributes: std::ptr::null_mut(),
      TargetAlias: PWSTR::null(),
      UserName: PWSTR(user_wide.as_mut_ptr())
    };

    CredWriteW(&credential, 0)?;
    Ok(())
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = (target, secret);
    anyhow::bail!("windows credential manager is unavailable on this platform")
  }
}

#[allow(dead_code)]
pub fn delete_secret(target: &str) -> Result<()> {
  #[cfg(target_os = "windows")]
  unsafe {
    let target_wide = wide_null(target);
    CredDeleteW(PCWSTR(target_wide.as_ptr()), CRED_TYPE_GENERIC, Some(0))?;
    Ok(())
  }

  #[cfg(not(target_os = "windows"))]
  {
    let _ = target;
    Ok(())
  }
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
  value.encode_utf16().chain(iter::once(0)).collect()
}
