///|
struct MetricPayload {
  host : String
  os : String
  cpu : Double
  memory : Double
  load1 : Double
  disk : Double
  rx_bps : Double
  tx_bps : Double
  uptime : Double
  gpu_utilization : Double
  gpu_memory : Double
}

///|
fn MetricPayload::json(self : MetricPayload) -> String {
  "{\"host\":\"\{self.host}\",\"os\":\"\{self.os}\",\"cpu\":\{self.cpu},\"memory\":\{self.memory},\"load1\":\{self.load1},\"disk\":\{self.disk},\"rx_bps\":\{self.rx_bps},\"tx_bps\":\{self.tx_bps},\"uptime\":\{self.uptime},\"gpu_utilization\":\{self.gpu_utilization},\"gpu_memory\":\{self.gpu_memory}}"
}

///|
test "payload has all expected fields" {
  let payload = MetricPayload::{
    host: "node-1",
    os: "linux",
    cpu: 0.25,
    memory: 0.5,
    load1: 1.0,
    disk: 0.75,
    rx_bps: 12.0,
    tx_bps: 34.0,
    uptime: 56.0,
    gpu_utilization: -1.0,
    gpu_memory: -1.0,
  }
  assert_eq(
    payload.json(),
    "{\"host\":\"node-1\",\"os\":\"linux\",\"cpu\":0.25,\"memory\":0.5,\"load1\":1," +
    "\"disk\":0.75,\"rx_bps\":12,\"tx_bps\":34,\"uptime\":56,\"gpu_utilization\":-1,\"gpu_memory\":-1}",
  )
}
