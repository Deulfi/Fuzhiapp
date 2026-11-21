// Jieli RCSP protocol core for the Wuzhi ZK-502MT (docs/PROTOCOL.md).
// Plain C++17, no ESPHome or ESP-IDF dependencies, so it can be unit-tested on a PC
// (esphome/tests/). Port of src/protocol/{auth,frame,codec,info,handshake}.ts.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace wuzhi_proto {

using Bytes = std::vector<uint8_t>;

std::string to_hex(const uint8_t *data, size_t len);
inline std::string to_hex(const Bytes &b) { return to_hex(b.data(), b.size()); }

// ---------------------------------------------------------------- auth (§4) ---

extern const uint8_t DEFAULT_LINK_KEY[16];
extern const uint8_t FIXED_ADDR[6];
extern const uint8_t AUTH_PASS[5];

enum AuthMsg : uint8_t { AUTH_CHALLENGE = 0x00, AUTH_RESPONSE = 0x01, AUTH_RESULT = 0x02 };

// Bluetooth E1 (SAFER+), full 16-byte output.
void e1(const uint8_t key[16], const uint8_t rand[16], const uint8_t addr6[6], uint8_t out[16]);

// 00 || random16
Bytes auth_challenge(const uint8_t random16[16]);
// 01 || E1(key, challenge16, FIXED_ADDR)
Bytes auth_response(const uint8_t challenge16[16], const uint8_t key[16] = DEFAULT_LINK_KEY);

// Non-blocking 5-step handshake (src/protocol/handshake.ts). The caller sends what
// begin()/feed() return and enforces the per-step timeout.
//   1. host -> dev  00 || R_host
//   2. dev -> host  01 || E1(R_host)     host verifies
//   3. host -> dev  02 "pass"
//   4. dev -> host  00 || R_dev          host answers 01 || E1(R_dev)
//   5. dev -> host  02 "pass"            authenticated
class AuthSession {
 public:
  enum State { IDLE, WAIT_DEVICE_RESPONSE, WAIT_DEVICE_CHALLENGE, WAIT_DEVICE_PASS, DONE, FAILED };

  struct Step {
    std::vector<Bytes> send;  // messages to write, in order
    std::string log;          // human-readable note (empty if nothing to say)
  };

  // Starts a new attempt with the given host random. Returns step 1.
  Step begin(const uint8_t random16[16]);
  // Feed one notification received while authenticating.
  Step feed(const uint8_t *data, size_t len);

  State state() const { return state_; }
  bool done() const { return state_ == DONE; }
  bool failed() const { return state_ == FAILED; }
  const std::string &error() const { return error_; }
  // 1..5: the step the session is waiting for (for timeout messages).
  int waiting_step() const;

 private:
  void answer_challenge(const uint8_t *challenge16, Step &step);

  State state_{IDLE};
  uint8_t r_host_[16]{};
  bool have_early_challenge_{false};
  uint8_t early_challenge_[16]{};
  std::string error_;
};

// ------------------------------------------------------------- frames (§3) ---

constexpr uint8_t FLAG_COMMAND = 0x80;
constexpr uint8_t FLAG_EXPECT_RESPONSE = 0x40;
constexpr size_t HEADER_LEN = 7;  // FE DC BA flags opcode lenHi lenLo
constexpr uint8_t FRAME_EOF = 0xEF;

namespace op {
constexpr uint8_t GET_TARGET_INFO = 0x03;
constexpr uint8_t GET_SYS_INFO = 0x07;
constexpr uint8_t SET_SYS_INFO = 0x08;
constexpr uint8_t SYS_INFO_PUSH = 0x09;
constexpr uint8_t FUNCTION = 0x0E;
constexpr uint8_t CUSTOM = 0xFF;
}  // namespace op

Bytes encode_raw(uint8_t flags, uint8_t opcode, const Bytes &params);
// Host command: params = sn || payload, flags C0 (or 80 without expect-response).
Bytes encode_command(uint8_t opcode, uint8_t sn, const Bytes &payload, bool expect_response = true);

struct Frame {
  uint8_t flags{0};
  uint8_t opcode{0};
  bool is_command{false};        // flags bit 7: command or device push, not a response
  bool expects_response{false};  // flags bit 6
  uint8_t sn{0};
  uint8_t status{0};  // responses only
  Bytes payload;      // after sn (commands) or status+sn (responses)
  Bytes raw;
};

// Interpret one complete frame (SOF..EOF). Returns false if params are too short.
bool decode_frame(const Bytes &raw, Frame &out);

// Bare ack for a device push that wants a reply (D6): flags 00, same opcode, [00][sn].
Bytes ack_for(const Frame &f);

// Notifications are a byte stream: a frame may span several notifications and one
// notification may carry several frames (src/protocol/codec.ts).
class FrameReassembler {
 public:
  explicit FrameReassembler(size_t max_param_len = 2048) : max_param_len_(max_param_len) {}
  void reset() { buf_.clear(); discarded_ = 0; }
  // Returns every frame completed by this chunk, in order.
  std::vector<Frame> push(const uint8_t *data, size_t len);
  size_t pending() const { return buf_.size(); }
  // Bytes thrown away since the last reset (garbage, false frame starts).
  size_t discarded() const { return discarded_; }

 private:
  void drop_front(size_t n);
  Bytes buf_;
  size_t max_param_len_;
  size_t discarded_{0};
};

// --------------------------------------------------- GetTargetInfo (§5) ---

struct Tlv {
  uint8_t type;
  Bytes data;
};

// [len = 1 + n][type][data(n)] repeated. Returns false on a truncated or zero-length entry.
bool parse_tlvs(const uint8_t *data, size_t len, std::vector<Tlv> &out);

// GetTargetInfo payload: mask FFFFFFFF, platform 00.
Bytes target_info_all_payload();

struct TargetInfo {
  bool has_protocol_version{false};
  uint8_t protocol_version{0};  // type 0, nibbles hi.lo
  bool has_power{false};        // type 1: battery, volume, max volume, flags
  uint8_t battery{0}, volume{0}, max_volume{0}, power_flags{0};
  bool has_edr{false};  // type 2: 6-byte address, profile, status (status 1 = A2DP connected)
  uint8_t edr_profile{0}, edr_status{0};
  bool has_functions{false};  // type 4: BE32 function mask + current function
  uint32_t function_mask{0};
  bool has_current_function{false};
  uint8_t current_function{0};
  std::vector<Tlv> tlvs;
};

bool parse_target_info(const Bytes &payload, TargetInfo &out);

const char *function_name(uint8_t fn);

// One-line summary, like describeTargetInfo() in src/protocol/info.ts. Contains no
// address or ID string.
std::string describe_target_info(const TargetInfo &t);

// One line per TLV: "type 0x02 (EDR address): xx xx xx xx xx xx 2d 01".
// Unless include_private is set, the EDR address (type 2), the serial-like part of the
// platform string (type 3) and the BLE address (type 17) are masked.
std::vector<std::string> describe_tlvs(const TargetInfo &t, bool include_private);

// ------------------------------------------------- GetSysInfo (§6.2, §6.3) ---

// GetSysInfo public, mask 0x0000FFF7 (the app's startup query): ff 00 00 ff f7
Bytes sys_info_public_all_payload();

// Gain is the public volume attribute (attr 1). The amp reports 0-30 and ignores 31-40; it
// does not clamp, so the host must (DECISIONS.md, "From the write tests").
constexpr uint8_t VOLUME_ATTR = 0x01;
constexpr int GAIN_LIMIT_MAX = 40;  // highest cap a user can configure, like the PWA slider

// SetSysInfo payload for gain v: ff 02 01 v. Returns an empty vector if v is above the cap
// (or the cap is above GAIN_LIMIT_MAX), so a refused value can never reach the amp.
Bytes set_gain_payload(int value, int cap);

// One step from `from` toward `to` (gainSteps() in src/app/state.ts). Returns `from` if equal.
int next_gain_step(int from, int to);

struct SysInfo {
  uint8_t function{0};
  bool is_public{false};
  bool has_volume{false};
  uint8_t volume{0};  // attr 1
  bool has_aux{false};
  bool aux_inserted{false};  // attr 2, byte 0 bit 4
  bool has_eq{false};
  uint8_t eq_mode{0};  // attr 4: mode + 10 signed gains
  int8_t eq_gains[10]{};
  bool has_current_function{false};
  uint8_t current_function{0};  // attr 6
  std::vector<Tlv> tlvs;
};

// GetSysInfo reply or 0x09 push payload: [function][TLVs]. Returns false if malformed.
bool parse_sys_info(const Bytes &payload, SysInfo &out);
std::string describe_sys_info(const SysInfo &s);

}  // namespace wuzhi_proto
