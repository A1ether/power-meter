import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/models.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode, this.body});

  final String message;
  final int? statusCode;
  final Object? body;

  @override
  String toString() => message;
}

/// 后端 HTTP 封装。
///
/// - Web：`baseUrl` 是当前 origin，请求同源，不带 token；
/// - 桌面：`baseUrl` 是 sidecar 的随机回环端口，带随机 token；
/// - 移动：`baseUrl` / token 由「连接服务」页填写。
///
/// 特权接口要求 `X-Power-Meter-Intent` 头（见 `src/server.ts:101-140`），
/// 这里对所有请求统一携带；同源请求不会因此产生额外预检。
class ApiClient {
  ApiClient({required Uri baseUrl, this.token = ''})
      : baseUrl = baseUrl.path.endsWith('/') ? baseUrl : baseUrl.replace(path: '${baseUrl.path}/');

  final Uri baseUrl;
  final String token;
  final http.Client _client = http.Client();

  static const String intentHeader = 'flutter-app';

  static const Duration _defaultTimeout = Duration(seconds: 30);
  static const Duration _summaryTimeout = Duration(seconds: 90);
  static const Duration _refreshTimeout = Duration(seconds: 120);

  Map<String, String> get _headers => {
        'Accept': 'application/json',
        if (token.isNotEmpty) 'X-Power-Meter-Token': token,
        'X-Power-Meter-Intent': intentHeader,
      };

  Uri _uri(String path, [Map<String, String>? query]) {
    final normalized = path.startsWith('/') ? path.substring(1) : path;
    final uri = baseUrl.resolve(normalized);
    return query == null || query.isEmpty ? uri : uri.replace(queryParameters: query);
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
    Duration timeout = _defaultTimeout,
  }) async {
    final request = http.Request(method, _uri(path, query))
      ..headers.addAll(_headers);
    if (body != null) {
      request.headers['Content-Type'] = 'application/json; charset=utf-8';
      request.body = jsonEncode(body);
    }
    try {
      final streamed = await _client.send(request).timeout(timeout);
      final response = await http.Response.fromStream(streamed);
      final text = utf8.decode(response.bodyBytes);
      final decoded = text.trim().isEmpty ? <String, dynamic>{} : jsonDecode(text);
      if (response.statusCode >= 400) {
        final message = decoded is Map && decoded['error'] is String
            ? decoded['error'] as String
            : '接口返回 ${response.statusCode}';
        throw ApiException(message, statusCode: response.statusCode, body: decoded);
      }
      if (decoded is! Map) {
        throw ApiException('接口返回了非对象 JSON', statusCode: response.statusCode, body: decoded);
      }
      return decoded.map((key, value) => MapEntry('$key', value));
    } on TimeoutException {
      throw ApiException('请求超时（$path）');
    } on http.ClientException catch (error) {
      throw ApiException('无法连接服务：${error.message}');
    }
  }

  Future<bool> health({Duration timeout = const Duration(seconds: 4)}) async {
    try {
      final payload = await _send('GET', 'api/health', timeout: timeout);
      return payload['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  Future<DashboardPayload> summary({bool force = false}) async {
    final payload = await _send(
      'GET',
      'api/summary',
      query: force ? {'force': '1'} : null,
      timeout: force ? _refreshTimeout : _summaryTimeout,
    );
    return DashboardPayload.fromJson(payload);
  }

  Future<DashboardPayload> refresh([List<String>? providers]) async {
    final payload = await _send(
      'POST',
      'api/refresh',
      body: {
        if (providers != null && providers.isNotEmpty) 'providers': providers,
      },
      timeout: _refreshTimeout,
    );
    return DashboardPayload.fromJson(payload);
  }

  Future<List<ProviderMeta>> providers() async {
    final payload = await _send('GET', 'api/providers');
    return (payload['providers'] as List? ?? const [])
        .whereType<Map>()
        .map((item) => ProviderMeta.fromJson(item.map((key, value) => MapEntry('$key', value))))
        .toList();
  }

  Future<AccountsOverview> accountsOverview() async =>
      AccountsOverview.fromJson(await _send('GET', 'api/accounts/overview'));

  Future<AccountsList> accounts(String provider) async => AccountsList.fromJson(
        await _send('GET', 'api/accounts', query: {'provider': provider}),
      );

  Future<Map<String, dynamic>> addAccount({
    required String provider,
    required Map<String, String> credentials,
    Map<String, String> options = const {},
    String? name,
    bool dryRun = false,
  }) =>
      _send(
        'POST',
        'api/accounts/add',
        body: {
          'provider': provider,
          'credentials': credentials,
          if (options.isNotEmpty) 'options': options,
          if (name != null && name.trim().isNotEmpty) 'name': name.trim(),
          if (dryRun) 'dryRun': true,
        },
        timeout: _refreshTimeout,
      );

  Future<Map<String, dynamic>> removeAccount({
    required String provider,
    required String accountId,
  }) =>
      _send('POST', 'api/accounts/remove', body: {
        'provider': provider,
        'accountId': accountId,
      });

  Future<String> revealSecret({
    required String provider,
    required String accountId,
    required String key,
  }) async {
    final payload = await _send('POST', 'api/reveal', body: {
      'provider': provider,
      'accountId': accountId,
      'key': key,
    });
    final value = payload['value'];
    if (value is! String || value.isEmpty) throw ApiException('凭证为空');
    return value;
  }

  Future<LoginSessionView> startLogin({
    required String provider,
    String? method,
    Map<String, String> options = const {},
    String? targetAccountId,
  }) async {
    final payload = await _send('POST', 'api/login/start', body: {
      'provider': provider,
      if (method != null && method != 'default') 'method': method,
      if (options.isNotEmpty) 'options': options,
      if (targetAccountId != null && targetAccountId.isNotEmpty) 'targetAccountId': targetAccountId,
    });
    return LoginSessionView.fromJson(
      (payload['session'] as Map?)?.map((key, value) => MapEntry('$key', value)) ??
          const <String, dynamic>{},
    );
  }

  Future<LoginSessionView> pollLogin(String id) async {
    final payload = await _send('GET', 'api/login/poll', query: {'id': id});
    return LoginSessionView.fromJson(
      (payload['session'] as Map?)?.map((key, value) => MapEntry('$key', value)) ??
          const <String, dynamic>{},
    );
  }

  Future<LoginSessionView> cancelLogin(String id) async {
    final payload = await _send('POST', 'api/login/cancel', body: {'id': id});
    return LoginSessionView.fromJson(
      (payload['session'] as Map?)?.map((key, value) => MapEntry('$key', value)) ??
          const <String, dynamic>{},
    );
  }

  void close() => _client.close();
}
