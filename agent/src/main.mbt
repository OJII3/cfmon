///|
#owned(path)
extern "C" fn read_file(path : Bytes) -> String = "cfmon_read_file"

///|
#owned(key)
extern "C" fn getenv(key : Bytes) -> String = "cfmon_getenv"

///|
extern "C" fn hostname() -> String = "cfmon_hostname"

///|
extern "C" fn os_name() -> String = "cfmon_os_name"

///|
extern "C" fn macos_metrics() -> String = "cfmon_macos_metrics"

///|
extern "C" fn nvidia_metrics() -> String = "cfmon_nvidia_metrics"

///|
extern "C" fn monotonic() -> Double = "cfmon_monotonic"

///|
extern "C" fn sleep_seconds(seconds : Int) -> Int = "cfmon_sleep"

///|
extern "C" fn disk_used() -> Double = "cfmon_disk_used"

///|
extern "C" fn process_exit(code : Int) -> Unit = "exit"

///|
#owned(url, state_dir, body)
extern "C" fn signed_post(url : Bytes, state_dir : Bytes, body : Bytes) -> Int = "cfmon_signed_post"

///|
#owned(state_dir)
extern "C" fn fingerprint(state_dir : Bytes) -> String = "cfmon_fingerprint"

///|
fn env(name : String) -> String {
  getenv(@utf8.encode(name))
}

///|
fn main {
  run_agent()
}
