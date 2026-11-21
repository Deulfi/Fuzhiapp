#pragma once

#ifdef USE_ESP32

#include <functional>
#include <vector>

#include "esphome/components/ble_client/ble_client.h"
#include "esphome/components/esp32_ble_tracker/esp32_ble_tracker.h"
#include "esphome/core/component.h"
#include "esphome/core/helpers.h"
#ifdef USE_NUMBER
#include "esphome/components/number/number.h"
#endif

#include "wuzhi_protocol.h"

namespace esphome {
namespace wuzhi_amp {

namespace espbt = esphome::esp32_ble_tracker;

// BLE bridge to a Wuzhi ZK-502MT amp (Jieli RCSP over GATT service AE00).
// Connects, runs the 5-step auth, sends GetTargetInfo and logs the decoded reply. With a gain
// number configured it also reads GetSysInfo, follows the 0x09 push and steps gain.
class WuzhiAmp : public Component, public ble_client::BLEClientNode {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::DATA; }

  void gattc_event_handler(esp_gattc_cb_event_t event, esp_gatt_if_t gattc_if,
                           esp_ble_gattc_cb_param_t *param) override;
  void gap_event_handler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t *param) override;

  void set_log_private(bool v) { this->log_private_ = v; }
  void set_query_target_info(bool v) { this->query_target_info_ = v; }
  void set_auth_delay(uint32_t ms) { this->auth_delay_ms_ = ms; }
  void set_pair(bool v) { this->pair_ = v; }

  bool is_ready() const { return this->link_ == Link::READY; }

#ifdef USE_NUMBER
  void set_gain_number(number::Number *n) { this->gain_number_ = n; }
#endif
  void set_max_gain(int v) { this->max_gain_ = v; }
  // From the gain number (Home Assistant, web page). Steps toward the value, capped.
  void request_gain(float value);

 protected:
  enum class Link { DISCONNECTED, PAIRING, DISCOVERED, AUTHENTICATING, READY };

  using ReplyHandler = std::function<void(const wuzhi_proto::Frame *reply)>;  // nullptr = timeout
  struct Pending {
    uint8_t opcode;
    uint8_t sn;
    uint32_t deadline;
    ReplyHandler handler;
  };

  void reset_link_();
  void enable_notifications_();
  void fail_and_back_off_();
  void schedule_auth_();
  void start_auth_();
  void handle_auth_step_(const wuzhi_proto::AuthSession::Step &step);
  void on_authenticated_();
  void on_notify_(const uint8_t *data, size_t len);
  void on_frame_(const wuzhi_proto::Frame &f);

  bool write_(const wuzhi_proto::Bytes &bytes);
  // Sends a command that expects a reply. handler gets the reply, or nullptr on timeout.
  bool request_(uint8_t opcode, const wuzhi_proto::Bytes &payload, ReplyHandler handler,
                uint32_t timeout_ms = 2000);

  void query_target_info_now_();
  void query_sys_info_now_();
  void apply_sys_info_(const wuzhi_proto::SysInfo &s, const char *source);
  void step_gain_();
  void publish_gain_();

  uint16_t write_handle_{0};
  uint16_t notify_handle_{0};
  Link link_{Link::DISCONNECTED};

  wuzhi_proto::AuthSession auth_;
  uint8_t auth_attempt_{0};
  uint32_t auth_step_deadline_{0};
  uint32_t cccd_fallback_at_{0};
  uint32_t auth_start_at_{0};
  uint32_t auth_delay_ms_{1000};
  uint32_t pair_deadline_{0};
  bool pair_{false};
  uint32_t backoff_ms_{0};
  uint32_t reconnect_at_{0};

  wuzhi_proto::FrameReassembler reassembler_;
  uint8_t sn_{0};
  std::vector<Pending> pending_;

  bool log_private_{false};
  bool query_target_info_{true};

  // gain (attr 1). -1 = not known yet.
#ifdef USE_NUMBER
  number::Number *gain_number_{nullptr};
#endif
  int max_gain_{40};
  int gain_current_{-1};
  int gain_target_{-1};
  bool gain_in_flight_{false};
  uint32_t gain_next_at_{0};
};

#ifdef USE_NUMBER
class GainNumber : public number::Number, public Parented<WuzhiAmp> {
 protected:
  void control(float value) override { this->parent_->request_gain(value); }
};
#endif

}  // namespace wuzhi_amp
}  // namespace esphome

#endif  // USE_ESP32
