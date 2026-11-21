"""Firmware and protocol version as Home Assistant text sensors."""

import esphome.codegen as cg
from esphome.components import text_sensor
import esphome.config_validation as cv
from esphome.const import ENTITY_CATEGORY_DIAGNOSTIC

from . import CONF_WUZHI_AMP_ID, WuzhiAmp

DEPENDENCIES = ["wuzhi_amp"]

CONF_FIRMWARE_VERSION = "firmware_version"
CONF_PROTOCOL_VERSION = "protocol_version"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_WUZHI_AMP_ID): cv.use_id(WuzhiAmp),
        # From the Wuzhi model query, e.g. "V002.10" (as the vendor app shows it)
        cv.Optional(CONF_FIRMWARE_VERSION): text_sensor.text_sensor_schema(
            text_sensor.TextSensor,
            icon="mdi:chip", entity_category=ENTITY_CATEGORY_DIAGNOSTIC
        ),
        # RCSP protocol version from GetTargetInfo, e.g. "2.1"
        cv.Optional(CONF_PROTOCOL_VERSION): text_sensor.text_sensor_schema(
            text_sensor.TextSensor,
            icon="mdi:information-outline", entity_category=ENTITY_CATEGORY_DIAGNOSTIC
        ),
    }
)


async def to_code(config):
    amp = await cg.get_variable(config[CONF_WUZHI_AMP_ID])
    if conf := config.get(CONF_FIRMWARE_VERSION):
        cg.add(amp.set_firmware_sensor(await text_sensor.new_text_sensor(conf)))
    if conf := config.get(CONF_PROTOCOL_VERSION):
        cg.add(amp.set_protocol_sensor(await text_sensor.new_text_sensor(conf)))
