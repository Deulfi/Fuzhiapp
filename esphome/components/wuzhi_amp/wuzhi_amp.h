#pragma once

#ifdef USE_ESP32

#include <functional>
#include <vector>

#include "esphome/components/ble_client/ble_client.h"
#include "esphome/components/esp32_ble_tracker/esp32_ble_tracker.h"
#include "esphome/core/component.h"

#include "wuzhi_protocol.h"

namespace esphome {
namespace wuzhi_amp {

namespace espbt = esphome::esp32_ble_tracker;

// BLE bridge to a Wuzhi ZK-502MT amp (Jieli RCSP over GATT service AE00).
// Milestone 1: connect, run the 5-step auth, send GetTargetInfo, log the decoded reply.
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
  bool pair_{true};
  uint32_t backoff_ms_{0};
  uint32_t reconnect_at_{0};

  wuzhi_proto::FrameReassembler reassembler_;
  uint8_t sn_{0};
  std::vector<Pending> pending_;

  bool log_private_{false};
  bool query_target_info_{true};
};

}  // namespace wuzhi_amp
}  // namespace esphome

#endif  // USE_ESP32
