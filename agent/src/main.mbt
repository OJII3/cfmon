///|
#owned(path)
extern "C" fn read_file(path : Bytes) -> String = "cfmon_read_file"

///|
#owned(key)
extern "C" fn getenv(key : Bytes) -> String = "cfmon_getenv"

///|
extern "C" fn hostname() -> String = "cfmon_hostname"

///|
extern "C" fn monotonic() -> Double = "cfmon_monotonic"

///|
extern "C" fn sleep_seconds(seconds : Int) -> Int = "cfmon_sleep"

///|
extern "C" fn disk_used() -> Double = "cfmon_disk_used"

///|
extern "C" fn process_exit(code : Int) -> Unit = "exit"

///|
#owned(url, token, body)
extern "C" fn post(url : Bytes, token : Bytes, body : Bytes) -> Int = "cfmon_post"

///|
fn env(name : String) -> String {
  getenv(@utf8.encode(name))
}

///|
fn main {
  run_agent()
}
