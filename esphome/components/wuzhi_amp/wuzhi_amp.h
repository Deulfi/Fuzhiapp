#pragma once

#ifdef USE_ESP32

#include <functional>
#include <vector>

#include "esphome/components/ble_client/ble_client.h"
#include "esphome/components/esp32_ble_tracker/esp32_ble_tracker.h"
#include "esphome/core/component.h"
#include "esphome/core/helpers.h"
#include "esphome/core/preferences.h"
#include <string>
#ifdef USE_NUMBER
#include "esphome/components/number/number.h"
#endif
#ifdef USE_SELECT
#include "esphome/components/select/select.h"
#endif
#ifdef USE_BINARY_SENSOR
#include "esphome/components/binary_sensor/binary_sensor.h"
#endif
#ifdef USE_SWITCH
#include "esphome/components/switch/switch.h"
#endif
#ifdef USE_BUTTON
#include "esphome/components/button/button.h"
#endif
#ifdef USE_TEXT_SENSOR
#include "esphome/components/text_sensor/text_sensor.h"
#endif

#include "wuzhi_protocol.h"

namespace esphome {
namespace wuzhi_amp {

namespace espbt = esphome::esp32_ble_tracker;

// BLE bridge to a Wuzhi ZK-502MT amp (Jieli RCSP over GATT service AE00).
// Connects, runs the 5-step auth, sends GetTargetInfo and logs the decoded reply. With a gain
// number configured it also reads GetSysInfo, follows the 0x09 push and steps gain.
class WuzhiAmp : public Component, public ble_client::BLEClientNode, public espbt::ESPBTDeviceListener {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::DATA; }

  void gattc_event_handler(esp_gattc_cb_event_t event, esp_gatt_if_t gattc_if,
                           esp_ble_gattc_cb_param_t *param) override;
  void gap_event_handler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t *param) override;
  // Scan results: adopts the first amp whose name matches, when no address is configured.
  bool parse_device(const espbt::ESPBTDevice &device) override;

  void set_name_prefix(const std::string &p) { this->name_prefix_ = p; }
  // From the "Forget amp" button: drop the stored amp and adopt the next one found.
  void forget_amp();

  void set_log_private(bool v) { this->log_private_ = v; }
  void set_query_target_info(bool v) { this->query_target_info_ = v; }
  void set_auth_delay(uint32_t ms) { this->auth_delay_ms_ = ms; }
  void set_pair(bool v) { this->pair_ = v; }

  bool is_ready() const { return this->link_ == Link::READY; }

#ifdef USE_NUMBER
  void set_gain_number(number::Number *n) { this->gain_number_ = n; }
#endif
  void set_max_gain(int v) { this->max_gain_ = v; }
#ifdef USE_SELECT
  void set_source_select(select::Select *s) { this->source_select_ = s; }
#endif
#ifdef USE_BINARY_SENSOR
  void set_aux_cable_sensor(binary_sensor::BinarySensor *s) { this->aux_cable_sensor_ = s; }
  void set_bt_audio_sensor(binary_sensor::BinarySensor *s) { this->bt_audio_sensor_ = s; }
  void set_connected_sensor(binary_sensor::BinarySensor *s) { this->connected_sensor_ = s; }
#endif
  // From the source select: 0 Bluetooth, 1 AUX, 2 Idle (display only).
  void request_source(size_t index);
#ifdef USE_SELECT
  void set_eq_select(select::Select *s) { this->eq_select_ = s; }
#endif
  // From the EQ select: mode 0-6 (Normal .. User).
  void request_eq(size_t mode);
#ifdef USE_SWITCH
  void set_aux_priority_switch(switch_::Switch *s) { this->aux_priority_switch_ = s; }
#endif
  void set_aux_priority(bool on);

  // beep (Wuzhi custom 0x02 / 0x12)
#ifdef USE_SWITCH
  void set_beep_switch(switch_::Switch *s) { this->beep_switch_ = s; }
#endif
#ifdef USE_NUMBER
  void set_beep_volume_number(number::Number *n) { this->beep_volume_number_ = n; }
  void set_eq_band_number(int band, number::Number *n) { this->eq_band_numbers_[band] = n; }
#endif
  void request_beep(int on, int volume);  // -1 = keep the current value
  // EQ band 0-9 (31 Hz .. 16 kHz) in dB: switches to the User EQ with that band changed.
  void request_eq_band(int band, float db);
  // "Disconnect phone audio": drops the phone's or computer's Bluetooth audio link.
  void disconnect_phone();
#ifdef USE_TEXT_SENSOR
  void set_firmware_sensor(text_sensor::TextSensor *s) { this->firmware_sensor_ = s; }
  void set_protocol_sensor(text_sensor::TextSensor *s) { this->protocol_sensor_ = s; }
#endif
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

  // then: called after the reply has been applied (or on timeout/error)
  void query_target_info_now_(std::function<void()> then = nullptr);
  void query_sys_info_now_();
  void apply_sys_info_(const wuzhi_proto::SysInfo &s, const char *source);
  void step_gain_();
  void publish_gain_();
  void apply_target_info_(const wuzhi_proto::TargetInfo &t);
  void set_source_(wuzhi_proto::Source s, const char *why);
  void publish_source_();
  void set_aux_cable_(bool in);
  void set_bt_audio_(bool on);
  void publish_connected_(bool on);
  bool needs_sys_info_() const;
  bool needs_target_poll_() const;
  void switch_source_(bool to_aux, const char *why);
  void publish_eq_();
  void write_eq_(uint8_t mode, const int8_t gains[10]);
  void publish_eq_bands_();
  void publish_beep_();
  void on_wuzhi_push_(uint8_t cmd, const wuzhi_proto::Bytes &data);
  void query_wuzhi_(uint8_t cmd);
  void drop_phone_step_();
  bool needs_beep_() const;
  void apply_eq_(uint8_t mode, const int8_t gains[10]);
  void retry_eq_(const char *why);
  void enforce_priority_(const char *why);

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

  // auto-find
  std::string name_prefix_{"wuzhi"};
  uint64_t configured_address_{0};  // from ble_client mac_address; 0 = find automatically
  uint64_t adopted_address_{0};
  ESPPreferenceObject address_pref_;

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

  // source, AUX cable, Bluetooth audio
#ifdef USE_SELECT
  select::Select *source_select_{nullptr};
#endif
#ifdef USE_BINARY_SENSOR
  binary_sensor::BinarySensor *aux_cable_sensor_{nullptr};
  binary_sensor::BinarySensor *bt_audio_sensor_{nullptr};
  binary_sensor::BinarySensor *connected_sensor_{nullptr};
#endif
  wuzhi_proto::Source source_{wuzhi_proto::Source::UNKNOWN};
  int aux_cable_{-1};  // -1 unknown
  int bt_audio_{-1};
  bool source_in_flight_{false};
  bool target_info_logged_{false};
  uint32_t next_target_poll_at_{0};

  // EQ (attr 4)
#ifdef USE_SELECT
  select::Select *eq_select_{nullptr};
#endif
  int eq_mode_{-1};
  int8_t eq_gains_[10]{};
  int eq_sent_mode_{-1};
  uint32_t eq_sent_at_{0};
  int eq_pending_mode_{-1};  // refused after power-on (E1), retried when Bluetooth audio starts
  int8_t eq_sent_gains_[10]{};
  int8_t eq_pending_gains_[10]{};
#ifdef USE_NUMBER
  number::Number *eq_band_numbers_[10]{};
#endif

  // beep
#ifdef USE_SWITCH
  switch_::Switch *beep_switch_{nullptr};
#endif
#ifdef USE_NUMBER
  number::Number *beep_volume_number_{nullptr};
#endif
  int beep_on_{-1};
  int beep_volume_{-1};

  // disconnect phone audio (PWA dropPhone), a small state machine run from loop()
  enum class Drop : uint8_t { IDLE, READ, TO_BLUETOOTH, SEND, VERIFY };
  Drop drop_{Drop::IDLE};
  uint32_t drop_deadline_{0};
  uint8_t drop_checks_{0};
  bool drop_waiting_{false};

#ifdef USE_TEXT_SENSOR
  text_sensor::TextSensor *firmware_sensor_{nullptr};
  text_sensor::TextSensor *protocol_sensor_{nullptr};
#endif
  std::string protocol_published_;

  // AUX priority (PWA amp.ts enforcePriority): reacts to changes only, never on connect.
#ifdef USE_SWITCH
  switch_::Switch *aux_priority_switch_{nullptr};
#endif
  bool aux_priority_{false};
  bool priority_suspended_{false};  // the user picked Bluetooth
  bool priority_gave_up_{false};
  uint32_t priority_tries_[6]{};
  uint8_t priority_try_count_{0};
  uint32_t priority_recheck_at_{0};
};

#ifdef USE_SELECT
class SourceSelect : public select::Select, public Parented<WuzhiAmp> {
 protected:
  void control(size_t index) override { this->parent_->request_source(index); }
};
#endif

#ifdef USE_SELECT
class EqSelect : public select::Select, public Parented<WuzhiAmp> {
 protected:
  void control(size_t index) override { this->parent_->request_eq(index); }
};
#endif

#ifdef USE_SWITCH
class BeepSwitch : public switch_::Switch, public Parented<WuzhiAmp> {
 protected:
  void write_state(bool state) override { this->parent_->request_beep(state ? 1 : 0, -1); }
};
#endif

#ifdef USE_NUMBER
class BeepVolumeNumber : public number::Number, public Parented<WuzhiAmp> {
 protected:
  void control(float value) override { this->parent_->request_beep(-1, static_cast<int>(value)); }
};

class EqBandNumber : public number::Number, public Parented<WuzhiAmp> {
 public:
  void set_band(int band) { this->band_ = band; }

 protected:
  void control(float value) override { this->parent_->request_eq_band(this->band_, value); }
  int band_{0};
};
#endif

#ifdef USE_BUTTON
class DisconnectPhoneButton : public button::Button, public Parented<WuzhiAmp> {
 protected:
  void press_action() override { this->parent_->disconnect_phone(); }
};
#endif

#ifdef USE_SWITCH
class AuxPrioritySwitch : public switch_::Switch, public Parented<WuzhiAmp> {
 protected:
  void write_state(bool state) override { this->parent_->set_aux_priority(state); }
};
#endif

#ifdef USE_BUTTON
class ForgetAmpButton : public button::Button, public Parented<WuzhiAmp> {
 protected:
  void press_action() override { this->parent_->forget_amp(); }
};
#endif

#ifdef USE_NUMBER
class GainNumber : public number::Number, public Parented<WuzhiAmp> {
 protected:
  void control(float value) override { this->parent_->request_gain(value); }
};
#endif

}  // namespace wuzhi_amp
}  // namespace esphome

#endif  // USE_ESP32
