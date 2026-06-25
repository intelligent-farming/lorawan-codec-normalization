// Authoring reference only — NOT shipped in the npm tarball (see package.json
// "files": "!codecs/**/reference") and NOT executed by this module.
//
// Source: Dragino published decoder for the WSC2-Compact-LS weather-station
// transmitter (the LoRaWAN node the DR-RG-6P rain-gauge probe attaches to),
// file WSC2-Compact-LS-V1.0.6_TTN_decoder.txt from
// https://github.com/dragino/dragino-end-node-decoder/tree/main/WSC2-Compact-LS
// and the product manual at
// https://wiki.dragino.com/xwiki/bin/view/Main/User%20Manual%20for%20LoRaWAN%20End%20Nodes/WSC2-Compact-LS--Weather_Station_Kit_User_Manual/
//
// Kept verbatim as the wire-format reference our normalized codec.js was
// authored from. This device is not in TheThingsNetwork/lorawan-devices, so
// there is no TTN provenance (device.json ttn is null).

function Decoder(bytes, port) {
	var data = {};
	var decode = {};
	var value;
	var k = 0;
	if (port == 0x02) {
		decode.BatV = ((bytes[0] << 8 | bytes[1]) & 0x3FFF) / 1000;
		decode.Payload_Ver = bytes[2];
		decode.rain = (bytes[3] << 24 | bytes[4] << 16 | bytes[5] << 8 | bytes[6]);
		value = bytes[7] << 8 | bytes[8];
		if (bytes[7] & 0x80) { value |= 0xFFFF0000; }
		decode.temp_DS18B20 = (value / 10).toFixed(2);
		decode.Temperature = parseFloat(((bytes[9] << 24 >> 16 | bytes[10]) / 10).toFixed(1));
		decode.Humidity = parseFloat(((bytes[11] << 8 | bytes[12]) / 10).toFixed(1));
		decode.Pressure = ((bytes[13] << 8 | bytes[14]) / 100).toFixed(2);
		decode.illumination = bytes[15] << 8 | bytes[16];
		decode.i_flag = (bytes[17] >> 5) & 0x01;
		if ((bytes[17] & 0x01) == 1) {
			value = bytes[20] << 8 | bytes[21];
			if ((value & 0x8000) >> 15 === 0) decode.temp_SOIL = (value / 100).toFixed(2);
			else if ((value & 0x8000) >> 15 === 1) decode.temp_SOIL = ((value - 0xFFFF) / 100).toFixed(2);
			decode.water_SOIL = ((bytes[18] << 8 | bytes[19]) / 100).toFixed(2);
			decode.conduct_SOIL = bytes[22] << 8 | bytes[23];
			k = k + 6;
		}
		if ((bytes[17] >> 1 & 0x01) == 1) {
			value = bytes[20 + k] << 8 | bytes[21 + k];
			if ((value & 0x8000) >> 15 === 0) decode.temp_SOIL2 = (value / 100).toFixed(2);
			else if ((value & 0x8000) >> 15 === 1) decode.temp_SOIL2 = ((value - 0xFFFF) / 100).toFixed(2);
			decode.water_SOIL2 = ((bytes[18 + k] << 8 | bytes[19 + k]) / 100).toFixed(2);
			decode.conduct_SOIL2 = bytes[22 + k] << 8 | bytes[23 + k];
			k = k + 6;
		}
		if ((bytes[17] >> 2 & 0x01) == 1) {
			decode.wind_speed_max = (((bytes[18 + k] << 8) | bytes[19 + k]) / 10).toFixed(1);
			decode.wind_speed_average = (((bytes[20 + k] << 8) | bytes[21 + k]) / 10).toFixed(1);
			decode.WIND_SPEED = ((bytes[22 + k] << 8 | bytes[23 + k]) / 10).toFixed(1);
			decode.WIND_LEVEL = bytes[24 + k] << 8 | bytes[25 + k];
			decode.WIND_ANGLE = ((bytes[26 + k] << 8 | bytes[27 + k]) / 10).toFixed(1);
			decode.WIND_DIRECTION = bytes[28 + k] << 8 | bytes[29 + k];
			k = k + 12;
		}
		if ((bytes[17] >> 3 & 0x01) == 1) {
			decode.TSR = bytes[18 + k] << 8 | bytes[19 + k];
			k = k + 2;
		}
		if ((bytes[17] >> 4 & 0x01) == 1) {
			decode.PAR = bytes[18 + k] << 8 | bytes[19 + k];
		}
		return decode;
	} else if (port == 0x05) {
		var sub_band, freq_band, sensor;
		if (bytes[0] == 0x4A) sensor = "WSC3-L";
		if (bytes[4] == 0xff) sub_band = "NULL"; else sub_band = bytes[4];
		if (bytes[3] == 0x01) freq_band = "EU868";
		else if (bytes[3] == 0x02) freq_band = "US915";
		else if (bytes[3] == 0x03) freq_band = "IN865";
		else if (bytes[3] == 0x04) freq_band = "AU915";
		else if (bytes[3] == 0x05) freq_band = "KZ865";
		else if (bytes[3] == 0x06) freq_band = "RU864";
		else if (bytes[3] == 0x07) freq_band = "AS923";
		else if (bytes[3] == 0x0B) freq_band = "CN470";
		var firm_ver = (bytes[1] & 0x0f) + '.' + (bytes[2] >> 4 & 0x0f) + '.' + (bytes[2] & 0x0f);
		var bat = (bytes[5] << 8 | bytes[6]) / 1000;
		return { SENSOR_MODEL: sensor, FIRMWARE_VERSION: firm_ver, FREQUENCY_BAND: freq_band, SUB_BAND: sub_band, BAT: bat };
	}
}
