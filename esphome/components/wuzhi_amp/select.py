"""Source (Bluetooth / AUX) and EQ preset as Home Assistant selects."""

import esphome.codegen as cg
from esphome.components import select
import esphome.config_validation as cv

from . import CONF_WUZHI_AMP_ID, WuzhiAmp, wuzhi_amp_ns

DEPENDENCIES = ["wuzhi_amp"]

CONF_SOURCE = "source"
CONF_EQ = "eq"
# Order matters: the C++ side uses the index (0 Bluetooth, 1 AUX, 2 Idle).
SOURCE_OPTIONS = ["Bluetooth", "AUX", "Idle"]

# Mode order 0-6 as the amp numbers them (OPEN_QUESTIONS S7).
EQ_OPTIONS = ["Normal", "Rock", "Pop", "Classical", "Jazz", "Country", "User"]

SourceSelect = wuzhi_amp_ns.class_("SourceSelect", select.Select)
EqSelect = wuzhi_amp_ns.class_("EqSelect", select.Select)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_WUZHI_AMP_ID): cv.use_id(WuzhiAmp),
        cv.Optional(CONF_SOURCE): select.select_schema(
            SourceSelect, icon="mdi:import"
        ),
        cv.Optional(CONF_EQ): select.select_schema(EqSelect, icon="mdi:equalizer"),
    }
)


async def to_code(config):
    amp = await cg.get_variable(config[CONF_WUZHI_AMP_ID])
    if source := config.get(CONF_SOURCE):
        s = await select.new_select(source, options=SOURCE_OPTIONS)
        await cg.register_parented(s, amp)
        cg.add(amp.set_source_select(s))
    if eq := config.get(CONF_EQ):
        s = await select.new_select(eq, options=EQ_OPTIONS)
        await cg.register_parented(s, amp)
        cg.add(amp.set_eq_select(s))
