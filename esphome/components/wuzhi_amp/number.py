"""Gain, beep volume and EQ bands as Home Assistant number entities."""

import esphome.codegen as cg
from esphome.components import number
import esphome.config_validation as cv
from esphome.const import ENTITY_CATEGORY_CONFIG, UNIT_DECIBEL

from . import CONF_WUZHI_AMP_ID, WuzhiAmp, wuzhi_amp_ns

DEPENDENCIES = ["wuzhi_amp"]

CONF_GAIN = "gain"
CONF_MAX_GAIN = "max_gain"
CONF_BEEP_VOLUME = "beep_volume"
# EQ bands as the PWA labels them (src/app/main.ts BANDS)
EQ_BANDS = ["31", "63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"]
EQ_BAND_KEYS = [f"eq_{b}" for b in EQ_BANDS]
EQ_GAIN_LIMIT = 12  # wuzhi_proto::EQ_GAIN_LIMIT
BEEP_VOLUME_MAX = 30

GainNumber = wuzhi_amp_ns.class_("GainNumber", number.Number)
BeepVolumeNumber = wuzhi_amp_ns.class_("BeepVolumeNumber", number.Number)
EqBandNumber = wuzhi_amp_ns.class_("EqBandNumber", number.Number)

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
        # Beep (prompt) volume, 0-30. Capped by max_gain like the gain itself.
        cv.Optional(CONF_BEEP_VOLUME): number.number_schema(
            BeepVolumeNumber, icon="mdi:volume-low", entity_category=ENTITY_CATEGORY_CONFIG
        ),
        # User EQ band gains in dB (-12..+12). Changing one switches to the User EQ.
        **{
            cv.Optional(key): number.number_schema(
                EqBandNumber, icon="mdi:tune-vertical", unit_of_measurement=UNIT_DECIBEL
            )
            for key in EQ_BAND_KEYS
        },
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
    if conf := config.get(CONF_BEEP_VOLUME):
        cap = BEEP_VOLUME_MAX
        if gain := config.get(CONF_GAIN):
            cap = min(cap, gain[CONF_MAX_GAIN])
        n = await number.new_number(conf, min_value=0, max_value=cap, step=1)
        await cg.register_parented(n, amp)
        cg.add(amp.set_beep_volume_number(n))
    for band, key in enumerate(EQ_BAND_KEYS):
        if conf := config.get(key):
            n = await number.new_number(
                conf, min_value=-EQ_GAIN_LIMIT, max_value=EQ_GAIN_LIMIT, step=1
            )
            await cg.register_parented(n, amp)
            cg.add(n.set_band(band))
            cg.add(amp.set_eq_band_number(band, n))
