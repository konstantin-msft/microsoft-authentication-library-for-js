/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { AccessTokenEntity, ICrypto, IdTokenEntity, Logger, ScopeSet, Authority, AuthorityOptions, ServerAuthorizationROPCResponse } from "@azure/msal-common";
import { BrowserConfiguration, buildConfiguration, Configuration } from "../config/Configuration";
import { SilentRequest } from "../request/SilentRequest";
import { BrowserCacheManager } from "./BrowserCacheManager";
import { ITokenCache } from "./ITokenCache";
import { BrowserAuthError } from "../error/BrowserAuthError";

export type LoadTokenOptions = {
    clientInfo?: string,
    extendedExpiresOn?: number,
    callback?: TokenCallback
};

export type TokenCallback = (key: string, value: string) => void;

/**
 * Token cache manager
 */
export class TokenCache implements ITokenCache {
    // Flag to indicate if in browser environment
    public isBrowserEnvironment: boolean;
    // Input configuration by developer/user
    protected config: BrowserConfiguration;
    // Browser cache storage
    private storage: BrowserCacheManager;
    // Logger
    private logger: Logger;
    // Crypto class
    private cryptoObj: ICrypto;

    constructor(configuration: Configuration, storage: BrowserCacheManager, logger: Logger, cryptoObj: ICrypto) {
        this.isBrowserEnvironment = typeof window !== "undefined";
        this.config = buildConfiguration(configuration, this.isBrowserEnvironment);
        this.storage = storage;
        this.logger = logger;
        this.cryptoObj = cryptoObj;
    }
    
    // Move getAllAccounts here and cache utility APIs

    /**
     * API to load tokens to msal-browser cache. 
     * @param request 
     * @param response
     * @param options
     */
    loadTokens(request: SilentRequest, response: ServerAuthorizationROPCResponse, options: LoadTokenOptions): void {
        this.logger.info("TokenCache - loadTokens called");

        if (!response.id_token) {
            throw BrowserAuthError.createUnableToLoadTokenError("Please ensure server response includes id token.");
        }

        if (request.account) {
            this.loadIdToken(response.id_token, request.account.homeAccountId, request.account.environment, request.account.tenantId, options);
            this.loadAccessToken(request, response, options, request.account.homeAccountId, request.account.environment, request.account.tenantId);
        } else if (request.authority) {

            const authorityOptions: AuthorityOptions = {
                protocolMode: this.config.auth.protocolMode,
                knownAuthorities: this.config.auth.knownAuthorities,
                cloudDiscoveryMetadata: this.config.auth.cloudDiscoveryMetadata,
                authorityMetadata: this.config.auth.authorityMetadata
            };
            const authority = new Authority(request.authority, this.config.system.networkClient, this.storage, authorityOptions);

            // If provided, clientInfo from options used before clientInfo in response
            if (options.clientInfo) {
                this.logger.trace("TokenCache - homeAccountId from options");
                this.loadIdToken(response.id_token, options.clientInfo, authority.hostnameAndPort, authority.tenant, options);
                this.loadAccessToken(request, response, options, options.clientInfo, authority.hostnameAndPort, authority.tenant);
            } else if (response.client_info) {
                this.logger.trace("TokenCache - homeAccountId from response");
                this.loadIdToken(response.id_token, response.client_info, authority.hostnameAndPort, authority.tenant, options);
                this.loadAccessToken(request, response, options, response.client_info, authority.hostnameAndPort, authority.tenant);
            } else {
                throw BrowserAuthError.createUnableToLoadTokenError("Please provide clientInfo in the response or options.");
            }
        } else {
            throw BrowserAuthError.createUnableToLoadTokenError("Please provide a request with an account or a request with authority.");
        }
    }

    /**
     * Helper function to load id tokens to msal-browser cache
     * @param idToken 
     * @param homeAccountId 
     * @param environment 
     * @param tenantId 
     * @param options 
     */
    private loadIdToken(idToken: string, homeAccountId: string, environment: string, tenantId: string, options: LoadTokenOptions): void {

        const idTokenEntity = IdTokenEntity.createIdTokenEntity(homeAccountId, environment, idToken, this.config.auth.clientId, tenantId);

        // If provided, callback takes precedence over storage set in config
        if (options.callback) {
            this.logger.verbose("TokenCache - callback with id token");
            const idTokenKey = idTokenEntity.generateCredentialKey();
            options.callback(idTokenKey, JSON.stringify(idTokenEntity));
        } else if (this.isBrowserEnvironment) {
            this.logger.verbose("TokenCache - loading id token");
            this.storage.setIdTokenCredential(idTokenEntity);
        } else {
            throw BrowserAuthError.createUnableToLoadTokenError("Please provide callback to cache id tokens in non-browser environments.");
        }
    }

    /**
     * Helper function to load access tokens to msal-browser cache
     * @param request 
     * @param response 
     * @param options 
     * @param homeAccountId 
     * @param environment 
     * @param tenantId 
     * @returns 
     */
    private loadAccessToken(request: SilentRequest, response: ServerAuthorizationROPCResponse, options: LoadTokenOptions, homeAccountId: string, environment: string, tenantId: string): void {

        if (!response.access_token) {
            this.logger.verbose("TokenCache - No access token provided for caching");
            return;
        }

        if (!response.expires_in) {
            throw BrowserAuthError.createUnableToLoadTokenError("Please ensure server response includes expires_in value.");
        }

        if (!options.extendedExpiresOn) {
            throw BrowserAuthError.createUnableToLoadTokenError("Please provide an extendedExpiresOn value in the options.");
        }
        
        const scopes = new ScopeSet(request.scopes).printScopes();
        const expiresOn = response.expires_in;
        const extendedExpiresOn = options.extendedExpiresOn;

        const accessTokenEntity = AccessTokenEntity.createAccessTokenEntity(homeAccountId, environment, response.access_token, this.config.auth.clientId, tenantId, scopes, expiresOn, extendedExpiresOn, this.cryptoObj);

        // If provided, callback takes precedence over storage set in config
        if (options.callback) {
            this.logger.verbose("TokenCache - callback access token");
            const accessTokenKey = accessTokenEntity.generateCredentialKey();
            options.callback(accessTokenKey, JSON.stringify(accessTokenEntity));
        } else if (this.isBrowserEnvironment) {
            this.logger.verbose("TokenCache - loading access token");
            this.storage.setAccessTokenCredential(accessTokenEntity);
        } else {
            throw BrowserAuthError.createUnableToLoadTokenError("Please provide callback to cache access tokens in non-browser environments");
        }
    }
}