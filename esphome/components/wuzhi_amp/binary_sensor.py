"""AUX cable, Bluetooth audio and link state as Home Assistant binary sensors."""

import esphome.codegen as cg
from esphome.components import binary_sensor
import esphome.config_validation as cv
from esphome.const import DEVICE_CLASS_CONNECTIVITY, DEVICE_CLASS_PLUG

from . import CONF_WUZHI_AMP_ID, WuzhiAmp

DEPENDENCIES = ["wuzhi_amp"]

CONF_AUX_CABLE = "aux_cable"
CONF_BLUETOOTH_AUDIO = "bluetooth_audio"
CONF_CONNECTED = "connected"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_WUZHI_AMP_ID): cv.use_id(WuzhiAmp),
        # GetSysInfo attr 2 bit 4, updated by the 0x09 push
        cv.Optional(CONF_AUX_CABLE): binary_sensor.binary_sensor_schema(
            binary_sensor.BinarySensor,
            device_class=DEVICE_CLASS_PLUG, icon="mdi:audio-input-rca"
        ),
        # TargetInfo type 2 status (A2DP). No push for it: re-read every 30 s and on source changes.
        cv.Optional(CONF_BLUETOOTH_AUDIO): binary_sensor.binary_sensor_schema(
            binary_sensor.BinarySensor,
            device_class=DEVICE_CLASS_CONNECTIVITY, icon="mdi:bluetooth-audio"
        ),
        # The bridge holds an authenticated control link to the amp
        cv.Optional(CONF_CONNECTED): binary_sensor.binary_sensor_schema(
            binary_sensor.BinarySensor,
            device_class=DEVICE_CLASS_CONNECTIVITY
        ),
    }
)


async def to_code(config):
    amp = await cg.get_variable(config[CONF_WUZHI_AMP_ID])
    if conf := config.get(CONF_AUX_CABLE):
        cg.add(amp.set_aux_cable_sensor(await binary_sensor.new_binary_sensor(conf)))
    if conf := config.get(CONF_BLUETOOTH_AUDIO):
        cg.add(amp.set_bt_audio_sensor(await binary_sensor.new_binary_sensor(conf)))
    if conf := config.get(CONF_CONNECTED):
        cg.add(amp.set_connected_sensor(await binary_sensor.new_binary_sensor(conf)))
