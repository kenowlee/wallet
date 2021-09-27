/* eslint-disable no-console */
import { watch } from '@vue/composition-api';
import { SignedTransaction } from '@nimiq/hub-api';
// @ts-expect-error no types
import { createRemote } from '../../../github/gentle_rpc/client/dist/remote'
// @ts-expect-error no types
import { wsProxyHandler } from '../../../github/gentle_rpc/client/dist/proxy'
import Config from 'config';

import { useAddressStore } from './stores/Address';
import { useTransactionsStore, Transaction, TransactionState } from './stores/Transactions';
import { useNetworkStore } from './stores/Network';
// import { useProxyStore } from './stores/Proxy';


import { Account, Block } from '../../../github/albatross-remote/src/lib/server-types'

let isLaunched = false;
let clientPromise: Promise<AlbatrossRpcClient>;

export enum ConsensusState {
    CONNECTING = 'connecting',
    SYNCING = 'syncing',
    ESTABLISHED = 'established',
}

export type Handle = number;
export type ConsensusChangedListener = (consensusState: ConsensusState) => any;
export type HeadChangedListener = (block: Block) => any;
export type TransactionListener = (transaction: Transaction) => any;

class AlbatrossRpcClient {
    private url: string;
    private remote?: Promise<any>;
    private blockSubscriptions: {
        [handle: number]: HeadChangedListener,
    } = {};

    private transactionSubscriptions: {
        [address: string]: TransactionListener[],
    } = {};

    constructor(url: string) {
        this.url = url;

        this.getRemote().then(async remote => {
            const id = await remote.headSubscribe([]);
            const { generator } = remote.subscription.listen();
            while (true) {
                const params = (await generator.next()).value;
                if (!params || params.subscription !== id) continue;

                const blockHash = params.result as string;
                const block = await remote.getBlockByHash([blockHash, true]) as Block;
                if (!block) continue;

                console.log(block);
                // Trigger block and transaction listeners
            }
        });
    }

    public addHeadChangedListener(listener: HeadChangedListener): Handle {
        let handle: Handle;
        do {
            handle = Math.round(Math.random() * 1000);
        } while (this.blockSubscriptions[handle]);

        this.blockSubscriptions[handle] = listener;
        return handle;
    }

    public addTransactionListener(listener: TransactionListener, address: string) {
        const listeners = this.transactionSubscriptions[address] || [];
        listeners.push(listener);
        this.transactionSubscriptions[address] = listeners;
    }

    public async getTransactionsByAddress(
        address: string,
        _fromHeight?: number,
        _knownTxs?: Transaction[],
        max?: number,
    ) {
        return this.rpc('getTransactionsByAddress', [address, max || null]) as Promise<Transaction[]>;
    }

    public async sendTransaction(tx: string | Transaction) {
        if (typeof tx === 'string') {
            const hash = await this.rpc<string>('sendRawTransaction', [tx]);
            do {
                // eslint-disable-next-line no-await-in-loop
                await new Promise(res => setTimeout(res, 500));
                try {
                    // eslint-disable-next-line no-await-in-loop
                    return await this.rpc('getTransactionByHash', [hash]) as Transaction;
                } catch (error) {
                    console.error(error);
                }
            } while (true); // eslint-disable-line no-constant-condition
        } else {
            throw new Error('UNIMPLEMENTED: sending transaction objects');
        }
    }

    public async getAccount(address: string): Promise<Account> {
        return this.rpc<Account>('getAccount', [address]);
    }

    private async getRemote(): Promise<any> {
        return this.remote || (this.remote = new Promise(async resolve => {
            const proxy = new Proxy(
                await createRemote(new WebSocket(`${this.url.replace('http', 'ws')}/ws`)),
                wsProxyHandler,
            );
            resolve(proxy);
        }))
    }

    private async rpc<T>(method: string, params: any[] = []): Promise<T> {
        const remote = await this.getRemote()
        return remote[method](params);
    }
}

export async function getNetworkClient() {
    clientPromise = clientPromise || Promise.resolve(new AlbatrossRpcClient(Config.networkEndpoint));

    return clientPromise;
}

export async function launchNetwork() {
    if (isLaunched) return;
    isLaunched = true;

    const client = await getNetworkClient();

    const { state: network$ } = useNetworkStore();
    const transactionsStore = useTransactionsStore();
    const addressStore = useAddressStore();

    function balancesListener(balances: Map<string, number>) {
        console.debug('Got new balances for', [...balances.keys()]);
        for (const [address, balance] of balances) {
            addressStore.patchAddress(address, { balance });
        }
    }
    // client.on(NetworkClient.Events.BALANCES, balancesListener);

    // client.on(NetworkClient.Events.CONSENSUS, (consensus) => network$.consensus = consensus);

    client.addHeadChangedListener((block) => {
        const height = block.blockNumber;
        console.debug('Head is now at', height);
        network$.height = height;
    });

    // client.on(NetworkClient.Events.PEER_COUNT, (peerCount) => network$.peerCount = peerCount);

    function transactionListener(plain: Transaction) {
        transactionsStore.addTransactions([plain]);
    }

    const subscribedAddresses = new Set<string>();
    const fetchedAddresses = new Set<string>();

    // Subscribe to new addresses (for balance updates and transactions)
    // Also remove logged out addresses from fetched (so that they get fetched on next login)
    watch(addressStore.addressInfos, () => {
        const newAddresses: string[] = [];
        const removedAddresses = new Set(subscribedAddresses);

        for (const address of Object.keys(addressStore.state.addressInfos)) {
            if (subscribedAddresses.has(address)) {
                removedAddresses.delete(address);
                continue;
            }

            subscribedAddresses.add(address);
            newAddresses.push(address);
        }

        if (removedAddresses.size) {
            for (const removedAddress of removedAddresses) {
                subscribedAddresses.delete(removedAddress);
                fetchedAddresses.delete(removedAddress);
            }
            // Let the network forget the balances of the removed addresses,
            // so that they are reported as new again at re-login.
            // client.forgetBalances([...removedAddresses]);
        }

        if (!newAddresses.length) return;

        console.debug('Subscribing addresses', newAddresses);
        for (const address of newAddresses) {
            client.addTransactionListener(transactionListener, address);
            client.getAccount(address).then(account => {
                addressStore.patchAddress(address, {
                    balance: account.balance,
                });
            });
        }
    });

    // Fetch transactions for active address
    watch(addressStore.activeAddress, (address) => {
        if (!address || fetchedAddresses.has(address)) return;
        fetchedAddresses.add(address);

        const knownTxDetails = Object.values(transactionsStore.state.transactions)
            .filter((tx) => tx.sender === address || tx.recipient === address);

        // const lastConfirmedHeight = knownTxDetails
        //     .filter((tx) => tx.state === TransactionState.CONFIRMED)
        //     .reduce((maxHeight, tx) => Math.max(tx.blockHeight!, maxHeight), 0);

        network$.fetchingTxHistory++;

        console.debug('Fetching transaction history for', address, knownTxDetails);
        // FIXME: Re-enable lastConfirmedHeight, but ensure it syncs from 0 the first time
        //        (even when cross-account transactions are already present)
        client.getTransactionsByAddress(address, /* lastConfirmedHeight - 10 */ 0, knownTxDetails)
            .then((txDetails) => {
                transactionsStore.addTransactions(txDetails);
            })
            .catch(() => fetchedAddresses.delete(address))
            .then(() => network$.fetchingTxHistory--);
    });

    // // Fetch transactions for proxies
    // const proxyStore = useProxyStore();
    // const seenProxies = new Set<string>();
    // const subscribedProxies = new Set<string>();
    // watch(proxyStore.networkTrigger, () => {
    //     const newProxies: string[] = [];
    //     const addressesToSubscribe: string[] = [];
    //     for (const proxyAddress of proxyStore.allProxies.value) {
    //         if (!seenProxies.has(proxyAddress)) {
    //             // For new addresses the tx history and if required subscribing is handled below
    //             seenProxies.add(proxyAddress);
    //             newProxies.push(proxyAddress);
    //             continue;
    //         }

    //         // If we didn't subscribe in the first pass, subscribe on second pass if needed, see below.
    //         if (
    //             !subscribedProxies.has(proxyAddress)
    //             && proxyStore.state.funded.includes(proxyAddress)
    //             && proxyStore.state.claimed.includes(proxyAddress)
    //         ) {
    //             subscribedProxies.add(proxyAddress);
    //             addressesToSubscribe.push(proxyAddress);
    //         }
    //     }
    //     if (addressesToSubscribe.length) {
    //         for (const address of addressesToSubscribe) {
    //             client.addTransactionListener(transactionListener, address);
    //         }
    //     }
    //     if (!newProxies.length) return;

    //     console.debug(`Fetching history for ${newProxies.length} proxies`);

    //     for (const proxyAddress of newProxies) {
    //         const knownTxDetails = Object.values(transactionsStore.state.transactions)
    //             .filter((tx) => tx.sender === proxyAddress || tx.recipient === proxyAddress);

    //         network$.fetchingTxHistory++;

    //         console.debug('Fetching transaction history for', proxyAddress, knownTxDetails);
    //         client.getTransactionsByAddress(proxyAddress, 0, knownTxDetails)
    //             .then((txDetails) => {
    //                 if (
    //                     proxyStore.state.funded.includes(proxyAddress)
    //                     && !subscribedProxies.has(proxyAddress)
    //                     && !txDetails.find((tx) => tx.sender === proxyAddress
    //                         && tx.state === TransactionState.CONFIRMED)
    //                 ) {
    //                     // No claiming transactions found, or the claiming tx is not yet confirmed, so we might need to
    //                     // subscribe for updates.
    //                     // If we were triggered by a funding transaction, we have to subscribe in any case because we
    //                     // don't know when and to where the proxy will be claimed. If we were triggered by a claimed
    //                     // transaction and don't know the funding transaction yet wait with subscribing until the second
    //                     // pass to see whether we actually have to subscribe (which is for example not the case if
    //                     // funding and claiming are both from/to addresses that are subscribed anyways; see
    //                     // needToSubscribe in ProxyDetection).
    //                     // If the funding tx has not been known so far, it will be added to the transaction store below
    //                     // which in turn runs the ProxyDetection again and triggers the network and this watcher again
    //                     // for the second pass if needed.
    //                     subscribedProxies.add(proxyAddress);
    //                     client.addTransactionListener(transactionListener, proxyAddress);
    //                 }
    //                 transactionsStore.addTransactions(txDetails);
    //             })
    //             .catch(() => seenProxies.delete(proxyAddress))
    //             .then(() => network$.fetchingTxHistory--);
    //     }
    // });
}

export async function sendTransaction(tx: SignedTransaction | string) {
    const client = await getNetworkClient();
    return client.sendTransaction(typeof tx === 'string' ? tx : tx.serializedTx);
}
