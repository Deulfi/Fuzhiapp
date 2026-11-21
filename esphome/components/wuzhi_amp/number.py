"""Gain as a Home Assistant number entity (public volume attribute, attr 1)."""

import esphome.codegen as cg
from esphome.components import number
import esphome.config_validation as cv

from . import CONF_WUZHI_AMP_ID, WuzhiAmp, wuzhi_amp_ns

DEPENDENCIES = ["wuzhi_amp"]

CONF_GAIN = "gain"
CONF_MAX_GAIN = "max_gain"

GainNumber = wuzhi_amp_ns.class_("GainNumber", number.Number)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_WUZHI_AMP_ID): cv.use_id(WuzhiAmp),
        cv.Optional(CONF_GAIN): number.number_schema(
            GainNumber, icon="mdi:volume-high"
        ).extend(
            {
                # Never sends more than this. The ZK-502MT uses 0-30 and ignores 31-40.
                cv.Optional(CONF_MAX_GAIN, default=40): cv.int_range(min=0, max=40),
            }
        ),
    }
)


async def to_code(config):
    amp = await cg.get_variable(config[CONF_WUZHI_AMP_ID])
    if gain := config.get(CONF_GAIN):
        n = await number.new_number(
            gain, min_value=0, max_value=gain[CONF_MAX_GAIN], step=1
        )
        await cg.register_parented(n, amp)
        cg.add(amp.set_gain_number(n))
        cg.add(amp.set_max_gain(gain[CONF_MAX_GAIN]))
