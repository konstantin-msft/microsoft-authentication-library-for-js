/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { AccountInfo, AuthenticationResult, AuthenticationScheme, IdTokenClaims, INativeBrokerPlugin, Logger, NativeRequest, PromptValue } from "@azure/msal-common";
import { Account, addon, AuthParameters, AuthResult, ReadAccountResult } from "@azure/msal-node-runtime";
import { version, name } from "../packageMetadata";

export class NativeBrokerPlugin implements INativeBrokerPlugin {
    private clientId: string;
    private logger: Logger;

    constructor(clientId: string, logger: Logger) { 
        this.clientId = clientId;
        this.logger = logger.clone(name, version);
    }

    async getAccountById(accountId: string, correlationId: string): Promise<AccountInfo> {
        this.logger.trace("NativeBrokerPlugin - getAccountById called", correlationId);
        const account = await this.readAccountById(accountId, correlationId);
        return this.generateAccountInfo(account);
    }

    async acquireTokenSilent(request: NativeRequest): Promise<AuthenticationResult> {
        this.logger.trace("NativeBrokerPlugin - acquireTokenSilent called", request.correlationId);
        const authParams = this.generateRequestParameters(request);
        let account: Account;
        if (request.accountId) {
            account = await this.readAccountById(request.accountId, request.correlationId);
        }

        return new Promise((resolve: (value: AuthenticationResult) => void, reject) => {
            const resultCallback = (result: AuthResult) => {
                try {
                    result.GetError();
                } catch (e) {
                    reject(e);
                }
                const authenticationResult = this.getAuthenticationResult(request, result);
                resolve(authenticationResult);
            };
            const callback = new addon.Callback(resultCallback);
            const asyncHandle = new addon.AsyncHandle();
            if (account) {
                addon.AcquireTokenSilently(authParams, account, request.correlationId, callback, asyncHandle);
            } else {
                addon.SignInSilently(authParams, request.correlationId, callback, asyncHandle);
            }
        });
    }

    async acquireTokenInteractive(request: NativeRequest): Promise<AuthenticationResult> {
        this.logger.trace("NativeBrokerPlugin - acquireTokenInteractive called", request.correlationId);
        const authParams = this.generateRequestParameters(request);
        let account;
        if (request.accountId) {
            account = await this.readAccountById(request.accountId, request.correlationId);
        }

        return new Promise((resolve: (value: AuthenticationResult) => void, reject) => {
            const resultCallback = (result: AuthResult) => {
                try {
                    result.GetError();
                } catch (e) {
                    reject(e);
                }
                const authenticationResult = this.getAuthenticationResult(request, result);
                resolve(authenticationResult);
            };
            const callback = new addon.Callback(resultCallback);
            const asyncHandle = new addon.AsyncHandle();
            switch (request.prompt) {
                case PromptValue.LOGIN:
                case PromptValue.SELECT_ACCOUNT:
                case PromptValue.CREATE:
                    addon.SignInInteractively(authParams, request.correlationId, request.loginHint, callback, asyncHandle);
                    break;
                case PromptValue.NONE:
                    if (account) {
                        addon.AcquireTokenSilently(authParams, account, request.correlationId, callback, asyncHandle);
                    } else {
                        addon.SignInSilently(authParams, request.correlationId, callback, asyncHandle);
                    }
                    break;
                default:
                    if (account) {
                        addon.AcquireTokenInteractively(authParams, account, request.correlationId, callback, asyncHandle);
                    } else {
                        addon.SignIn(authParams, request.correlationId, request.loginHint, callback, asyncHandle);
                    }
                    break;
            }
        });
    }

    private async readAccountById(accountId: string, correlationId: string): Promise<Account> {
        this.logger.trace("NativeBrokerPlugin - readAccountById called", correlationId);

        return new Promise((resolve, reject) => {
            const resultCallback = (result: ReadAccountResult) => {
                try {
                    result.GetError();
                } catch (e) {
                    reject(e);
                }
                const account = result.GetAccount();
                resolve(account);
            };

            const callback = new addon.Callback(resultCallback);
            const asyncHandle = new addon.AsyncHandle();
            addon.ReadAccountById(accountId, correlationId, callback, asyncHandle);
        });
    }

    private generateRequestParameters(request: NativeRequest): AuthParameters {
        this.logger.trace("NativeBrokerPlugin - generateRequestParameters called", request.correlationId);
        const authParams = new addon.AuthParameters(this.clientId, request.authority);
        authParams.SetRedirectUri(request.redirectUri);
        authParams.SetRequestedScopes(request.scopes.join(" "));

        if (request.claims) {
            authParams.SetDecodedClaims(request.claims);
        }

        if (request.authenticationScheme === AuthenticationScheme.POP) {
            if (!request.resourceRequestMethod || !request.resourceRequestUri || !request.shrNonce) {
                throw new Error("Authentication Scheme set to POP but one or more of the following parameters are missing: resourceRequestMethod, resourceRequestUri, shrNonce");
            }
            const resourceUrl = new URL(request.resourceRequestUri);
            authParams.SetPopParams(request.resourceRequestMethod, resourceUrl.host, resourceUrl.pathname, request.shrNonce);
        }
        
        if (request.extraParameters) {
            Object.keys(request.extraParameters).forEach((key) => {
                authParams.SetAdditionalParameter(key, request.extraParameters[key]);
            });
        }

        return authParams;
    }

    private getAuthenticationResult(request: NativeRequest, authResult: AuthResult): AuthenticationResult {
        this.logger.trace("NativeBrokerPlugin - getAuthenticationResult called", request.correlationId);
        const accessToken = authResult.GetAccessToken();
        const rawIdToken = authResult.GetRawIdToken();
        const idToken = authResult.GetIdToken();
        const scopes = authResult.GetGrantedScopes();
        const expiresOn = authResult.GetExpiresOn();
        const telemetryData = authResult.GetTelemetryData();
        
        let fromCache;
        try {
            const telemetryJSON = JSON.parse(telemetryData);
            fromCache = !!telemetryJSON["is_cache"];
        } catch (e) {
            this.logger.error("NativeBrokerPlugin: getAuthenticationResult - Error parsing telemetry data. Could not determine if response came from cache.", request.correlationId);
        } 
        
        const isPop = authResult.IsPopAuthorization();
        const account = authResult.GetAccount();

        let idTokenClaims: IdTokenClaims;
        try {
            idTokenClaims = JSON.parse(idToken);
        } catch (e) {
            throw new Error("Unable to parse idToken claims");
        }

        const accountInfo = this.generateAccountInfo(account, idTokenClaims);

        const result: AuthenticationResult = {
            authority: request.authority,
            uniqueId: idTokenClaims.oid || idTokenClaims.sub || "",
            tenantId: idTokenClaims.tid || "",
            scopes: scopes.split(" "),
            account: accountInfo,
            idToken: rawIdToken,
            idTokenClaims: idTokenClaims,
            accessToken: accessToken,
            fromCache: fromCache,
            expiresOn: new Date(expiresOn * 1000),
            tokenType: isPop ? AuthenticationScheme.POP : AuthenticationScheme.BEARER,
            correlationId: request.correlationId,
            fromNativeBroker: true
        };
        return result;
    }

    private generateAccountInfo(account: Account, idTokenClaims?: IdTokenClaims): AccountInfo {
        this.logger.trace("NativeBrokerPlugin - generateAccountInfo called");

        const accountInfo: AccountInfo = {
            homeAccountId: account.GetHomeAccountId(),
            environment: account.GetEnvironment(),
            tenantId: account.GetRealm(),
            username: account.GetUsername(),
            localAccountId: account.GetLocalAccountId(),
            name: account.GetDisplayName(),
            idTokenClaims: idTokenClaims,
            nativeAccountId: account.GetAccountId()
        };
        return accountInfo;
    }
}