import 'package:shared_preferences/shared_preferences.dart';

/// 移动端连接信息与全端主题偏好。
///
/// 只保存「服务地址 / 访问令牌 / 主题模式」，不保存任何平台凭证；
/// 平台凭证始终只在服务端 `.env` / `accounts.json` 中。
class SettingsStore {
  SettingsStore._(this._prefs);

  final SharedPreferences _prefs;

  static const _kServerBaseUrl = 'serverBaseUrl';
  static const _kServerToken = 'serverToken';
  static const _kThemeMode = 'themeMode';

  static Future<SettingsStore> load() async =>
      SettingsStore._(await SharedPreferences.getInstance());

  Uri? get serverBaseUrl {
    final raw = _prefs.getString(_kServerBaseUrl) ?? '';
    if (raw.isEmpty) return null;
    final parsed = Uri.tryParse(raw);
    if (parsed == null || !parsed.hasScheme || parsed.host.isEmpty) return null;
    return parsed.path.endsWith('/') ? parsed : parsed.replace(path: '${parsed.path}/');
  }

  String get serverToken => _prefs.getString(_kServerToken) ?? '';

  Future<void> saveServer({required String baseUrl, required String token}) async {
    await _prefs.setString(_kServerBaseUrl, baseUrl.trim());
    await _prefs.setString(_kServerToken, token.trim());
  }

  String get themeMode => _prefs.getString(_kThemeMode) ?? 'system';

  Future<void> saveThemeMode(String mode) => _prefs.setString(_kThemeMode, mode);
}
